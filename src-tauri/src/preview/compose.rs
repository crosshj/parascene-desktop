//! Pre-render compose regions + mix A1 (audio-lane) into the MSE A/V stream.

use crate::library::catalog::{default_paths, get_creation_by_id, ready_connection};
use crate::library::ffmpeg::resolve_ffmpeg;
use crate::library::proxy::{ensure_proxies, PROXY_FPS, PROXY_PLAY_H, PROXY_PLAY_W};
use crate::preview::cache::{get_cached, put_cached};
use crate::preview::fmp4::{read_file, rewrite_tfdt_base, split_init_media, write_file};
use crate::preview::remux::RemuxOutput;
use crate::preview::timeline::{
    clip_source_sec, find_clip_at, overlapping_audio_clips, PreviewSeekMode, PreviewTimelineClip,
};
use std::path::{Path, PathBuf};
use std::process::Command;

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("ffmpeg compose failed: {err}"))
    }
}

fn local_media_path(asset_id: &str) -> Result<PathBuf, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let c = get_creation_by_id(&conn, asset_id)?
        .ok_or_else(|| format!("Missing creation {asset_id}"))?;
    let p = c
        .local_path
        .ok_or_else(|| format!("No local media for {asset_id}"))?;
    Ok(PathBuf::from(p))
}

fn resolve_source(clip: &PreviewTimelineClip, mode: PreviewSeekMode) -> Result<PathBuf, String> {
    // Fill/stretch must frame from the original (or bake), not the already-letterboxed
    // 16:9 proxy — otherwise cover/fill zooms into padded bars.
    let framing = clip.framing.as_deref().unwrap_or("fit");
    let needs_raw = framing == "fill" || framing == "stretch"
        || matches!(clip.transform.as_deref(), Some("kenBurns"));

    if let Some(bake) = clip.bake_path.as_deref().filter(|p| Path::new(p).is_file()) {
        return Ok(PathBuf::from(bake));
    }
    let asset_id = clip
        .asset_id
        .as_deref()
        .ok_or_else(|| format!("Clip {} missing assetId", clip.id))?;

    if needs_raw {
        return local_media_path(asset_id);
    }

    if let Ok(r) = ensure_proxies(None, asset_id) {
        if r.status == "ready" {
            let p = match mode {
                PreviewSeekMode::Scrub => r.scrub_path,
                PreviewSeekMode::Playback => r.play_path,
            };
            if let Some(p) = p.filter(|s| Path::new(s).is_file()) {
                return Ok(PathBuf::from(p));
            }
        }
    }
    local_media_path(asset_id)
}

fn opacity_from_effects(clip: &PreviewTimelineClip) -> f64 {
    clip.effects
        .as_ref()
        .and_then(|es| es.iter().find(|e| e.kind == "opacity"))
        .map(|e| e.value.clamp(0.0, 1.0))
        .unwrap_or(1.0)
}

fn framing_filter(clip: &PreviewTimelineClip, frame_w: u32, frame_h: u32) -> String {
    let framing = clip.framing.as_deref().unwrap_or("fit");
    match framing {
        // Cover into the project frame (then caller pads to 16:9 stage).
        "fill" => format!(
            "scale={frame_w}:{frame_h}:force_original_aspect_ratio=increase,crop={frame_w}:{frame_h}"
        ),
        "stretch" => format!("scale={frame_w}:{frame_h}"),
        // Contain into the 16:9 preview stage.
        _ => format!(
            "scale={PROXY_PLAY_W}:{PROXY_PLAY_H}:force_original_aspect_ratio=decrease,pad={PROXY_PLAY_W}:{PROXY_PLAY_H}:(ow-iw)/2:(oh-ih)/2"
        ),
    }
}

fn ken_burns_filter(
    clip: &PreviewTimelineClip,
    local_t: f64,
    clip_dur: f64,
    frame_w: u32,
    frame_h: u32,
) -> String {
    let framing = framing_filter(clip, frame_w, frame_h);
    let progress = if clip_dur > 0.001 {
        (local_t / clip_dur).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let zoom = 1.0 + 0.12 * progress;
    let (zw, zh) = {
        let f = clip.framing.as_deref().unwrap_or("fit");
        if f == "fill" || f == "stretch" {
            (frame_w, frame_h)
        } else {
            (PROXY_PLAY_W, PROXY_PLAY_H)
        }
    };
    format!(
        "{framing},zoompan=z='min(zoom+0.0001\\,{zoom})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={zw}x{zh}:fps={PROXY_FPS}"
    )
}

fn build_vf(
    clip: &PreviewTimelineClip,
    timeline_sec: f64,
    dur: f64,
    frame_w: u32,
    frame_h: u32,
) -> String {
    let clip_dur = (clip.end_sec - clip.start_sec).max(0.001);
    let local_t = timeline_sec - clip.start_sec;
    let mut vf = if matches!(clip.transform.as_deref(), Some("kenBurns")) {
        ken_burns_filter(clip, local_t, clip_dur, frame_w, frame_h)
    } else {
        framing_filter(clip, frame_w, frame_h)
    };
    let framing = clip.framing.as_deref().unwrap_or("fit");
    if framing == "fill" || framing == "stretch" {
        // Center project frame inside the 16:9 stage (matches editor matte).
        vf.push_str(&format!(
            ",pad={PROXY_PLAY_W}:{PROXY_PLAY_H}:(ow-iw)/2:(oh-ih)/2:black"
        ));
    }
    vf.push_str(&format!(",fps={PROXY_FPS},format=yuv420p"));
    let opacity = opacity_from_effects(clip);
    if (opacity - 1.0).abs() > 0.001 {
        vf.push_str(&format!(
            ",format=yuva420p,colorchannelmixer=aa={opacity},format=yuv420p"
        ));
    }
    if let Some(tin) = &clip.transition_in {
        if tin.kind == "fadeBlack" || tin.kind == "dissolve" {
            let edge = timeline_sec - clip.start_sec;
            if edge < tin.duration_sec {
                vf.push_str(&format!(
                    ",fade=t=in:st=0:d={:.3}",
                    dur.min(tin.duration_sec - edge)
                ));
            }
        }
    }
    if let Some(tout) = &clip.transition_out {
        if tout.kind == "fadeBlack" || tout.kind == "dissolve" {
            let remaining = clip.end_sec - timeline_sec;
            if remaining <= tout.duration_sec {
                vf.push_str(&format!(",fade=t=out:st=0:d={:.3}", dur.min(remaining)));
            }
        }
    }
    if clip.reverse.unwrap_or(false) {
        vf = format!("reverse,{vf}");
    }
    vf
}

fn project_frame_size(aspect: &str) -> (u32, u32) {
    let parts: Vec<&str> = aspect.split(':').collect();
    if parts.len() == 2 {
        if let (Ok(w), Ok(h)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            if w > 0 && h > 0 {
                let scale =
                    (PROXY_PLAY_W as f64 / w as f64).min(PROXY_PLAY_H as f64 / h as f64);
                let out_w = ((w as f64) * scale).round().max(2.0) as u32 & !1;
                let out_h = ((h as f64) * scale).round().max(2.0) as u32 & !1;
                return (out_w, out_h);
            }
        }
    }
    (PROXY_PLAY_W, PROXY_PLAY_H)
}

fn audio_recipe_suffix(audio_clips: &[&PreviewTimelineClip]) -> String {
    audio_clips
        .iter()
        .map(|c| {
            format!(
                "{}:{:.3}-{:.3}:{}:{}",
                c.id,
                c.start_sec,
                c.end_sec,
                c.in_sec.unwrap_or(0.0),
                c.asset_id.as_deref().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

fn encode_flags(gop: &str, dur: f64, out: &Path) -> Vec<String> {
    vec![
        "-c:v".into(),
        "libx264".into(),
        "-profile:v".into(),
        "main".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-crf".into(),
        "26".into(),
        "-g".into(),
        gop.into(),
        "-keyint_min".into(),
        gop.into(),
        "-sc_threshold".into(),
        "0".into(),
        "-bf".into(),
        "0".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "128k".into(),
        "-t".into(),
        format!("{dur:.6}"),
        "-movflags".into(),
        "frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        "-y".into(),
        out.display().to_string(),
    ]
}

/// Compose one fragment, mixing video-lane audio (when included) with A1 audio-lane clips.
pub fn compose_fragment_at(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
    mode: PreviewSeekMode,
    out_dir: &Path,
    fragment_id: &str,
    recipe_key: &str,
    aspect_ratio: &str,
) -> Result<RemuxOutput, String> {
    let visual = find_clip_at(clips, timeline_sec);
    let audio_clips = overlapping_audio_clips(clips, timeline_sec, duration);

    // Always cover the full requested window — truncating to clip.end leaves MSE holes.
    let dur = duration.max(0.05);
    if let Some(clip) = visual {
        if clip.end_sec < timeline_sec + dur - 0.001 {
            // Compose region ends mid-window; fall back to stitched remux for continuity.
            return crate::preview::remux::remux_fragment_at(
                clips,
                timeline_sec,
                dur,
                mode,
                out_dir,
                fragment_id,
            );
        }
    }
    let mode_s = match mode {
        PreviewSeekMode::Scrub => "scrub",
        PreviewSeekMode::Playback => "play",
    };
    let full_recipe = format!(
        "{}|a={}|ar={}",
        recipe_key,
        audio_recipe_suffix(&audio_clips),
        aspect_ratio
    );

    if let Some(cached) = get_cached(&full_recipe, timeline_sec, dur, mode_s) {
        return split_cached(&cached, out_dir, fragment_id, timeline_sec, dur);
    }

    let Some(clip) = visual else {
        return compose_audio_mix_fragment(clips, timeline_sec, dur, out_dir, fragment_id);
    };

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let src = resolve_source(clip, mode)?;
    let src_start = clip_source_sec(clip, timeline_sec);
    let (frame_w, frame_h) = project_frame_size(aspect_ratio);
    let vf = build_vf(clip, timeline_sec, dur, frame_w, frame_h);
    let gop = if matches!(mode, PreviewSeekMode::Scrub) {
        "1"
    } else {
        "30"
    };
    let include_visual_audio = clip.include_audio.unwrap_or(true);
    let raw = out_dir.join(format!("{fragment_id}.compose.mp4"));

    let mut args: Vec<String> = vec![
        "-ss".into(),
        format!("{src_start:.6}"),
        "-t".into(),
        format!("{dur:.6}"),
        "-i".into(),
        src.display().to_string(),
    ];
    for a in &audio_clips {
        let path = resolve_source(a, mode)?;
        let a_start = clip_source_sec(a, timeline_sec.max(a.start_sec));
        args.extend([
            "-ss".into(),
            format!("{a_start:.6}"),
            "-t".into(),
            format!("{dur:.6}"),
            "-i".into(),
            path.display().to_string(),
        ]);
    }

    // Always use filter_complex when A1 is present or visual audio is muted
    // (so we still produce a consistent AAC track).
    if !audio_clips.is_empty() || !include_visual_audio {
        let mut filter = format!("[0:v]{vf}[vout];");
        let mut a_pads: Vec<String> = Vec::new();

        if include_visual_audio {
            filter.push_str(
                "[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[ava];",
            );
            a_pads.push("[ava]".into());
        }
        for (i, _) in audio_clips.iter().enumerate() {
            let idx = i + 1;
            let lab = format!("aa{i}");
            filter.push_str(&format!(
                "[{idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[{lab}];"
            ));
            a_pads.push(format!("[{lab}]"));
        }

        if a_pads.is_empty() {
            // Muted visual, no A1 — silent AAC.
            args.extend([
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("anullsrc=r=48000:cl=stereo:d={dur:.3}"),
            ]);
            let silent_idx = 1 + audio_clips.len();
            filter.push_str(&format!(
                "[{silent_idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[aout]"
            ));
        } else if a_pads.len() == 1 {
            let pad = &a_pads[0];
            filter.push_str(&format!("{pad}anull[aout]"));
        } else {
            let joined = a_pads.join("");
            filter.push_str(&format!(
                "{joined}amix=inputs={}:duration=first:dropout_transition=0[aout]",
                a_pads.len()
            ));
        }

        args.extend([
            "-filter_complex".into(),
            filter,
            "-map".into(),
            "[vout]".into(),
            "-map".into(),
            "[aout]".into(),
        ]);
    } else {
        args.extend([
            "-vf".into(),
            vf,
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "0:a?".into(),
        ]);
    }

    args.extend(encode_flags(gop, dur, &raw));
    run_ffmpeg(&ffmpeg, &args)?;
    let cached = put_cached(&full_recipe, timeline_sec, dur, mode_s, &raw)?;
    split_cached(&cached, out_dir, fragment_id, timeline_sec, dur)
}

fn split_cached(
    cached: &Path,
    out_dir: &Path,
    fragment_id: &str,
    timeline_start: f64,
    duration: f64,
) -> Result<RemuxOutput, String> {
    let data = read_file(cached)?;
    let (init, mut media) = split_init_media(&data)?;
    rewrite_tfdt_base(&mut media, 0);
    let init_path = out_dir.join(format!("{fragment_id}.init.mp4"));
    let media_path = out_dir.join(format!("{fragment_id}.m4s"));
    write_file(&init_path, &init)?;
    write_file(&media_path, &media)?;
    Ok(RemuxOutput {
        init_path,
        media_path,
        timeline_start,
        duration,
    })
}

/// Mix A1 sources onto a black video bed (gaps with audio only).
pub fn compose_audio_mix_fragment(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let audio_clips = overlapping_audio_clips(clips, timeline_sec, duration);
    if audio_clips.is_empty() {
        return Err("No audio clips in range".into());
    }

    let raw = out_dir.join(format!("{fragment_id}.audio.mp4"));
    let color = format!(
        "color=c=black:s={PROXY_PLAY_W}x{PROXY_PLAY_H}:r={PROXY_FPS}:d={duration:.3}"
    );
    let mut args: Vec<String> = vec!["-f".into(), "lavfi".into(), "-i".into(), color];
    for c in &audio_clips {
        let path = resolve_source(c, PreviewSeekMode::Playback)?;
        let src_start = clip_source_sec(c, timeline_sec.max(c.start_sec));
        args.extend([
            "-ss".into(),
            format!("{src_start:.6}"),
            "-t".into(),
            format!("{duration:.6}"),
            "-i".into(),
            path.display().to_string(),
        ]);
    }
    let n = audio_clips.len();
    let mut filter = String::new();
    for i in 1..=n {
        filter.push_str(&format!(
            "[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}];"
        ));
    }
    if n == 1 {
        filter.push_str("[a1]anull[aout]");
    } else {
        for i in 1..=n {
            filter.push_str(&format!("[a{i}]"));
        }
        filter.push_str(&format!(
            "amix=inputs={n}:duration=first:dropout_transition=0[aout]"
        ));
    }
    args.extend([
        "-filter_complex".into(),
        filter,
        "-map".into(),
        "0:v".into(),
        "-map".into(),
        "[aout]".into(),
    ]);
    args.extend(encode_flags("30", duration, &raw));
    run_ffmpeg(&ffmpeg, &args)?;
    split_cached(&raw, out_dir, fragment_id, timeline_sec, duration)
}

/// Black video + silent AAC — keeps the MSE timeline contiguous across gaps
/// or remux failures so playback never stalls forever waiting for missing media.
pub fn compose_gap_fragment(
    timeline_sec: f64,
    duration: f64,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let raw = out_dir.join(format!("{fragment_id}.gap.mp4"));
    let color = format!(
        "color=c=black:s={PROXY_PLAY_W}x{PROXY_PLAY_H}:r={PROXY_FPS}:d={duration:.3}"
    );
    let silent = format!("anullsrc=r=48000:cl=stereo:d={duration:.3}");
    let mut args: Vec<String> = vec![
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        color,
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        silent,
        "-map".into(),
        "0:v".into(),
        "-map".into(),
        "1:a".into(),
        "-shortest".into(),
    ];
    args.extend(encode_flags("30", duration, &raw));
    run_ffmpeg(&ffmpeg, &args)?;
    split_cached(&raw, out_dir, fragment_id, timeline_sec, duration)
}
