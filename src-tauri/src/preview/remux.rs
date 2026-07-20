//! Remux proxy fragments for cut spans with timeline timestamps.
//!
//! Scrub mode uses all-intra proxies with `-c copy` (near-instant).
//! Playback cuts use ultrafast re-encode so mid-GOP seeks stay decodable
//! and always include AAC audio. A1 mixes re-encode audio only when video
//! can be copied from the scrub proxy.

use crate::library::ffmpeg::resolve_ffmpeg;
use crate::library::proxy::{ensure_proxies, proxy_paths_for};
use crate::preview::cache::{get_cached, put_cached};
use crate::preview::fmp4::{read_file, rewrite_tfdt_base, split_init_media, write_file};
use crate::preview::timeline::{
    clip_source_sec, find_clip_at, overlapping_audio_clips, PreviewSeekMode, PreviewTimelineClip,
};
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct RemuxOutput {
    pub init_path: PathBuf,
    pub media_path: PathBuf,
    pub timeline_start: f64,
    pub duration: f64,
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
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
        Err(format!("ffmpeg remux failed: {err}"))
    }
}

fn run_ffmpeg_owned(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
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
        Err(format!("ffmpeg remux failed: {err}"))
    }
}

fn proxy_for_clip(
    clip: &PreviewTimelineClip,
    mode: PreviewSeekMode,
) -> Result<PathBuf, String> {
    let asset_id = clip
        .asset_id
        .as_deref()
        .ok_or_else(|| format!("Clip {} missing assetId", clip.id))?;
    if let Ok(Some(existing)) = proxy_paths_for(asset_id) {
        if existing.status == "ready" {
            let preferred = match mode {
                PreviewSeekMode::Scrub => existing.scrub_path.as_ref(),
                PreviewSeekMode::Playback => existing.play_path.as_ref(),
            };
            if let Some(p) = preferred.filter(|p| Path::new(p.as_str()).is_file()) {
                return Ok(PathBuf::from(p));
            }
            if let Some(p) = existing
                .scrub_path
                .as_ref()
                .filter(|p| Path::new(p.as_str()).is_file())
                .or_else(|| {
                    existing
                        .play_path
                        .as_ref()
                        .filter(|p| Path::new(p.as_str()).is_file())
                })
            {
                return Ok(PathBuf::from(p));
            }
        }
    }
    let r = ensure_proxies(None, asset_id)?;
    if r.status != "ready" {
        return Err(format!("Proxies not ready for {asset_id} ({})", r.status));
    }
    let preferred = match mode {
        PreviewSeekMode::Scrub => r.scrub_path.as_ref(),
        PreviewSeekMode::Playback => r.play_path.as_ref(),
    };
    preferred
        .filter(|p| Path::new(p.as_str()).is_file())
        .or_else(|| {
            r.scrub_path
                .as_ref()
                .filter(|p| Path::new(p.as_str()).is_file())
        })
        .or_else(|| {
            r.play_path
                .as_ref()
                .filter(|p| Path::new(p.as_str()).is_file())
        })
        .map(|p| PathBuf::from(p))
        .ok_or_else(|| format!("No proxy file for {asset_id}"))
}

fn split_to_fragment(
    raw: &Path,
    out_dir: &Path,
    fragment_id: &str,
    timeline_start: f64,
    duration: f64,
) -> Result<RemuxOutput, String> {
    let data = read_file(raw)?;
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

fn remux_recipe(
    proxy: &Path,
    src_start: f64,
    duration: f64,
    mode: PreviewSeekMode,
    include_audio: bool,
) -> String {
    format!(
        "remux|{}|{src_start:.3}|{duration:.3}|{}|a={}",
        proxy.display(),
        match mode {
            PreviewSeekMode::Scrub => "scrub",
            PreviewSeekMode::Playback => "play",
        },
        include_audio as u8
    )
}

/// Extract `[src_start, src_start+dur)` from proxy and emit init+media.
pub fn remux_clip_range(
    clip: &PreviewTimelineClip,
    timeline_start: f64,
    duration: f64,
    mode: PreviewSeekMode,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    // Scrub always prefers all-intra for instant copy seeks.
    let proxy_mode = match mode {
        PreviewSeekMode::Scrub => PreviewSeekMode::Scrub,
        // Playback cuts still prefer scrub (all-intra) when available for
        // reliable `-c copy`; fall back to play proxy via proxy_for_clip.
        PreviewSeekMode::Playback => PreviewSeekMode::Scrub,
    };
    let proxy = proxy_for_clip(clip, proxy_mode).or_else(|_| proxy_for_clip(clip, mode))?;
    let src_start = clip_source_sec(clip, timeline_start);
    let include_audio = clip.include_audio.unwrap_or(true);
    let mode_s = match mode {
        PreviewSeekMode::Scrub => "scrub",
        PreviewSeekMode::Playback => "play",
    };
    let recipe = remux_recipe(&proxy, src_start, duration, mode, include_audio);

    if let Some(cached) = get_cached(&recipe, timeline_start, duration, mode_s) {
        return split_to_fragment(&cached, out_dir, fragment_id, timeline_start, duration);
    }

    let raw = out_dir.join(format!("{fragment_id}.raw.mp4"));
    let src_s = proxy.to_string_lossy();
    let raw_s = raw.to_string_lossy();
    let ss = format!("{src_start:.6}");
    let t = format!("{duration:.6}");

    // Prefer bitstream copy from scrub/all-intra. If that fails (play proxy
    // mid-GOP), fall back to ultrafast re-encode so A/V always land.
    let copy_ok = if include_audio {
        run_ffmpeg(
            &ffmpeg,
            &[
                "-ss",
                ss.as_str(),
                "-t",
                t.as_str(),
                "-i",
                src_s.as_ref(),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                raw_s.as_ref(),
            ],
        )
        .is_ok()
            && raw.is_file()
    } else {
        run_ffmpeg(
            &ffmpeg,
            &[
                "-ss",
                ss.as_str(),
                "-t",
                t.as_str(),
                "-i",
                src_s.as_ref(),
                "-map",
                "0:v:0",
                "-an",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                raw_s.as_ref(),
            ],
        )
        .is_ok()
            && raw.is_file()
    };

    if !copy_ok {
        let _ = std::fs::remove_file(&raw);
        let mut args: Vec<String> = vec![
            "-ss".into(),
            ss.clone(),
            "-t".into(),
            t.clone(),
            "-i".into(),
            src_s.to_string(),
            "-map".into(),
            "0:v:0".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-tune".into(),
            "zerolatency".into(),
            "-profile:v".into(),
            "main".into(),
            "-crf".into(),
            "28".into(),
            "-g".into(),
            "30".into(),
            "-bf".into(),
            "0".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ];
        if include_audio {
            args.extend([
                "-map".into(),
                "0:a:0?".into(),
                "-c:a".into(),
                "aac".into(),
                "-ar".into(),
                "48000".into(),
                "-ac".into(),
                "2".into(),
                "-b:a".into(),
                "96k".into(),
            ]);
        } else {
            args.push("-an".into());
        }
        args.extend([
            "-movflags".into(),
            "frag_keyframe+empty_moov+default_base_moof".into(),
            "-f".into(),
            "mp4".into(),
            "-y".into(),
            raw_s.to_string(),
        ]);
        run_ffmpeg_owned(&ffmpeg, &args)?;
    }

    let cached = put_cached(&recipe, timeline_start, duration, mode_s, &raw)?;
    let out = split_to_fragment(&cached, out_dir, fragment_id, timeline_start, duration)?;
    let _ = std::fs::remove_file(&raw);
    Ok(out)
}

/// Remux video (`-c copy` / ultrafast) and mix A1 audio without full video re-encode.
pub fn remux_with_audio_mix(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
    mode: PreviewSeekMode,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let visual = find_clip_at(clips, timeline_sec)
        .ok_or_else(|| format!("No visual clip at t={timeline_sec}"))?;
    let audio_clips = overlapping_audio_clips(clips, timeline_sec, duration);
    if audio_clips.is_empty() {
        return remux_clip_range(visual, timeline_sec, duration, mode, out_dir, fragment_id);
    }

    let dur = duration.max(0.05);
    // Amix assumes one visual clip covers the whole window; otherwise stitch.
    if visual.end_sec < timeline_sec + dur - 0.001 {
        return remux_fragment_at(clips, timeline_sec, dur, mode, out_dir, fragment_id);
    }
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let proxy = proxy_for_clip(visual, PreviewSeekMode::Scrub)
        .or_else(|_| proxy_for_clip(visual, mode))?;
    let src_start = clip_source_sec(visual, timeline_sec);
    let include_visual_audio = visual.include_audio.unwrap_or(true);
    let mode_s = match mode {
        PreviewSeekMode::Scrub => "scrub",
        PreviewSeekMode::Playback => "play",
    };
    let a_key: String = audio_clips
        .iter()
        .map(|c| {
            format!(
                "{}:{:.3}:{:.3}",
                c.id,
                c.start_sec,
                clip_source_sec(c, timeline_sec.max(c.start_sec))
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    let recipe = format!(
        "a1mix|{}|{src_start:.3}|{dur:.3}|va={}|{}",
        proxy.display(),
        include_visual_audio as u8,
        a_key
    );

    if let Some(cached) = get_cached(&recipe, timeline_sec, dur, mode_s) {
        return split_to_fragment(&cached, out_dir, fragment_id, timeline_sec, dur);
    }

    let raw = out_dir.join(format!("{fragment_id}.a1.mp4"));
    let mut args: Vec<String> = vec![
        "-ss".into(),
        format!("{src_start:.6}"),
        "-t".into(),
        format!("{dur:.6}"),
        "-i".into(),
        proxy.display().to_string(),
    ];
    for a in &audio_clips {
        let path = proxy_for_clip(a, PreviewSeekMode::Scrub)
            .or_else(|_| proxy_for_clip(a, PreviewSeekMode::Playback))?;
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

    let mut filter = String::new();
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
    if a_pads.len() == 1 {
        filter.push_str(&format!("{}anull[aout]", a_pads[0]));
    } else {
        filter.push_str(&format!(
            "{}amix=inputs={}:duration=first:dropout_transition=0[aout]",
            a_pads.join(""),
            a_pads.len()
        ));
    }

    // Video: copy from all-intra when possible; audio always re-encoded for the mix.
    args.extend([
        "-filter_complex".into(),
        filter.clone(),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "[aout]".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "aac".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "96k".into(),
        "-movflags".into(),
        "frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        "-y".into(),
        raw.display().to_string(),
    ]);

    if run_ffmpeg_owned(&ffmpeg, &args).is_err() {
        // Copy failed (play proxy mid-GOP) — ultrafast video + mixed audio.
        let _ = std::fs::remove_file(&raw);
        let mut args2: Vec<String> = vec![
            "-ss".into(),
            format!("{src_start:.6}"),
            "-t".into(),
            format!("{dur:.6}"),
            "-i".into(),
            proxy.display().to_string(),
        ];
        for a in &audio_clips {
            let path = proxy_for_clip(a, PreviewSeekMode::Scrub)
                .or_else(|_| proxy_for_clip(a, PreviewSeekMode::Playback))?;
            let a_start = clip_source_sec(a, timeline_sec.max(a.start_sec));
            args2.extend([
                "-ss".into(),
                format!("{a_start:.6}"),
                "-t".into(),
                format!("{dur:.6}"),
                "-i".into(),
                path.display().to_string(),
            ]);
        }
        args2.extend([
            "-filter_complex".into(),
            filter,
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "[aout]".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-tune".into(),
            "zerolatency".into(),
            "-profile:v".into(),
            "main".into(),
            "-crf".into(),
            "28".into(),
            "-g".into(),
            "30".into(),
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
            "96k".into(),
            "-movflags".into(),
            "frag_keyframe+empty_moov+default_base_moof".into(),
            "-f".into(),
            "mp4".into(),
            "-y".into(),
            raw.display().to_string(),
        ]);
        run_ffmpeg_owned(&ffmpeg, &args2)?;
    }

    let cached = put_cached(&recipe, timeline_sec, dur, mode_s, &raw)?;
    let out = split_to_fragment(&cached, out_dir, fragment_id, timeline_sec, dur)?;
    let _ = std::fs::remove_file(&raw);
    Ok(out)
}

/// Remux a timeline window of exactly `duration` seconds (except at sequence end).
///
/// Important: must not truncate at clip boundaries. Short fragments leave holes
/// between integer-second stage points (e.g. clip ends at 3.5 → media [3,3.5),
/// next fragment starts at 4.0 → gap → MSE buffers forever).
pub fn remux_fragment_at(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
    mode: PreviewSeekMode,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let duration = duration.max(0.05);
    let window_end = timeline_sec + duration;

    // Fast path: one visual clip covers the entire window.
    if let Some(clip) = find_clip_at(clips, timeline_sec) {
        if clip.end_sec >= window_end - 0.001 {
            return remux_clip_range(clip, timeline_sec, duration, mode, out_dir, fragment_id);
        }
    }

    remux_stitched_window(clips, timeline_sec, duration, mode, out_dir, fragment_id)
}

fn gap_raw_file(ffmpeg: &Path, duration: f64, dest: &Path) -> Result<(), String> {
    let color = format!(
        "color=c=black:s=1280x720:r=30:d={duration:.3}"
    );
    let silent = format!("anullsrc=r=48000:cl=stereo:d={duration:.3}");
    let dest_s = dest.to_string_lossy();
    run_ffmpeg(
        ffmpeg,
        &[
            "-f",
            "lavfi",
            "-i",
            color.as_str(),
            "-f",
            "lavfi",
            "-i",
            silent.as_str(),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "-y",
            dest_s.as_ref(),
        ],
    )
}

fn remux_clip_to_raw_file(
    clip: &PreviewTimelineClip,
    timeline_start: f64,
    duration: f64,
    mode: PreviewSeekMode,
    dest: &Path,
) -> Result<(), String> {
    // Reuse remux_clip_range into a temp dir name, then copy raw before delete —
    // simpler: call remux logic writing directly to dest as the "raw" output.
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let proxy_mode = PreviewSeekMode::Scrub;
    let proxy = proxy_for_clip(clip, proxy_mode).or_else(|_| proxy_for_clip(clip, mode))?;
    let src_start = clip_source_sec(clip, timeline_start);
    let include_audio = clip.include_audio.unwrap_or(true);
    let src_s = proxy.to_string_lossy();
    let dest_s = dest.to_string_lossy();
    let ss = format!("{src_start:.6}");
    let t = format!("{duration:.6}");

    let copy_ok = if include_audio {
        run_ffmpeg(
            &ffmpeg,
            &[
                "-ss",
                ss.as_str(),
                "-t",
                t.as_str(),
                "-i",
                src_s.as_ref(),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                dest_s.as_ref(),
            ],
        )
        .is_ok()
            && dest.is_file()
    } else {
        run_ffmpeg(
            &ffmpeg,
            &[
                "-ss",
                ss.as_str(),
                "-t",
                t.as_str(),
                "-i",
                src_s.as_ref(),
                "-map",
                "0:v:0",
                "-an",
                "-c",
                "copy",
                "-avoid_negative_ts",
                "make_zero",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                dest_s.as_ref(),
            ],
        )
        .is_ok()
            && dest.is_file()
    };

    if copy_ok {
        return Ok(());
    }
    let _ = std::fs::remove_file(dest);
    let mut args: Vec<String> = vec![
        "-ss".into(),
        ss,
        "-t".into(),
        t,
        "-i".into(),
        src_s.to_string(),
        "-map".into(),
        "0:v:0".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "ultrafast".into(),
        "-tune".into(),
        "zerolatency".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ];
    if include_audio {
        args.extend([
            "-map".into(),
            "0:a:0?".into(),
            "-c:a".into(),
            "aac".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args.extend([
        "-movflags".into(),
        "frag_keyframe+empty_moov+default_base_moof".into(),
        "-f".into(),
        "mp4".into(),
        "-y".into(),
        dest_s.to_string(),
    ]);
    run_ffmpeg_owned(&ffmpeg, &args)
}

fn next_visual_start(clips: &[PreviewTimelineClip], after: f64) -> Option<f64> {
    clips
        .iter()
        .filter(|c| c.lane.as_deref() != Some("audio") && c.start_sec > after + 0.001)
        .map(|c| c.start_sec)
        .fold(None, |acc, s| Some(acc.map_or(s, |a: f64| a.min(s))))
}

fn remux_stitched_window(
    clips: &[PreviewTimelineClip],
    timeline_sec: f64,
    duration: f64,
    mode: PreviewSeekMode,
    out_dir: &Path,
    fragment_id: &str,
) -> Result<RemuxOutput, String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let window_end = timeline_sec + duration;
    let mut cursor = timeline_sec;
    let mut parts: Vec<PathBuf> = Vec::new();
    let mut part_i = 0u32;

    while cursor < window_end - 0.01 {
        let left = window_end - cursor;
        let part = out_dir.join(format!("{fragment_id}.part{part_i}.mp4"));
        if let Some(clip) = find_clip_at(clips, cursor) {
            let piece = (clip.end_sec - cursor).min(left).max(0.05);
            remux_clip_to_raw_file(clip, cursor, piece, mode, &part)?;
            cursor += piece;
        } else {
            let until = next_visual_start(clips, cursor)
                .unwrap_or(window_end)
                .min(window_end);
            let piece = (until - cursor).min(left).max(0.05);
            gap_raw_file(&ffmpeg, piece, &part)?;
            cursor += piece;
        }
        parts.push(part);
        part_i += 1;
        if part_i > 24 {
            return Err("Timeline window stitch too fragmented".into());
        }
    }

    if parts.is_empty() {
        return Err("Empty stitch window".into());
    }

    let joined = out_dir.join(format!("{fragment_id}.stitch.mp4"));
    if parts.len() == 1 {
        let _ = std::fs::rename(&parts[0], &joined)
            .or_else(|_| std::fs::copy(&parts[0], &joined).map(|_| ()));
        let _ = std::fs::remove_file(&parts[0]);
    } else {
        // Re-encode concat so timestamps are continuous inside the window.
        let list = out_dir.join(format!("{fragment_id}.concat.txt"));
        let mut body = String::new();
        for p in &parts {
            body.push_str(&format!("file '{}'\n", p.display()));
        }
        std::fs::write(&list, body).map_err(|e| e.to_string())?;
        let list_s = list.to_string_lossy();
        let joined_s = joined.to_string_lossy();
        run_ffmpeg(
            &ffmpeg,
            &[
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                list_s.as_ref(),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-tune",
                "zerolatency",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                joined_s.as_ref(),
            ],
        )?;
        let _ = std::fs::remove_file(&list);
        for p in &parts {
            let _ = std::fs::remove_file(p);
        }
    }

    let out = split_to_fragment(&joined, out_dir, fragment_id, timeline_sec, duration)?;
    let _ = std::fs::remove_file(&joined);
    Ok(out)
}
