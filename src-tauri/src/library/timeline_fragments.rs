//! Preview-quality timeline fragments for MSE playback.
//!
//! Each fragment is a 1–3s closed-GOP fMP4 with identical codec params so the
//! frontend can append/replace ranges on a single SourceBuffer. Encode is
//! deliberately softer/smaller than Publisher export.

use super::catalog::default_paths;
use super::ffmpeg::resolve_ffmpeg;
use super::render::{
    aspect_parts, build_video_segments, concat_demixer_line, fit_inside, run_ffmpeg, safe_id,
    Framing, RenderTimelineClipInput, VideoSegment, VideoSource, RENDER_FPS,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const PREVIEW_STAGE_W: u32 = 960;
const PREVIEW_STAGE_H: u32 = 540;
const PREVIEW_CRF: &str = "28";
const PREVIEW_PRESET: &str = "ultrafast";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFragmentBakeResult {
    pub path: String,
    pub index: u32,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineFragmentConcatResult {
    pub path: String,
}

fn preview_dir(paths: &super::paths::ParascenePaths, project_id: &str) -> PathBuf {
    paths
        .cache
        .join("timeline-preview")
        .join(safe_id(project_id))
}

fn preview_output_size(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (540, 540),
        "9:16" => (540, 960),
        "4:5" => (540, 676),
        _ => (960, 540),
    }
}

fn preview_frame_filter(
    out_w: u32,
    out_h: u32,
    crop_w: u32,
    crop_h: u32,
    framing: Framing,
) -> String {
    let prefix = "setsar=1";
    let tail = format!("fps={RENDER_FPS:.0},format=yuv420p");
    match framing {
        Framing::Fit => format!(
            "{prefix},scale={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:force_original_aspect_ratio=decrease,pad={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:(ow-iw)/2:(oh-ih)/2:black,crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,scale={out_w}:{out_h},setsar=1,{tail}"
        ),
        Framing::Fill => format!(
            "{prefix},scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},setsar=1,{tail}"
        ),
        Framing::Stretch => {
            format!("{prefix},scale={out_w}:{out_h},setsar=1,{tail}")
        }
    }
}

fn push_preview_x264(args: &mut Vec<String>, gop_frames: u32) {
    let gop = gop_frames.max(1).to_string();
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push(PREVIEW_PRESET.into());
    args.push("-crf".into());
    args.push(PREVIEW_CRF.into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-profile:v".into());
    args.push("baseline".into());
    args.push("-level".into());
    args.push("3.1".into());
    args.push("-bf".into());
    args.push("0".into());
    args.push("-refs".into());
    args.push("1".into());
    args.push("-g".into());
    args.push(gop.clone());
    args.push("-keyint_min".into());
    args.push(gop.clone());
    args.push("-sc_threshold".into());
    args.push("0".into());
    args.push("-x264-params".into());
    args.push(format!(
        "keyint={gop}:min-keyint={gop}:scenecut=0:open-gop=0:repeat-headers=1:aud=1:cabac=0:8x8dct=0:weightp=0:weightb=0"
    ));
    args.push("-colorspace".into());
    args.push("bt709".into());
    args.push("-color_primaries".into());
    args.push("bt709".into());
    args.push("-color_trc".into());
    args.push("bt709".into());
    args.push("-color_range".into());
    args.push("tv".into());
    args.push("-video_track_timescale".into());
    args.push("30000".into());
}

fn push_preview_fmp4_flags(args: &mut Vec<String>) {
    args.push("-movflags".into());
    args.push("+empty_moov+default_base_moof+frag_keyframe+omit_tfhd_offset".into());
}

fn fragment_frame_count(duration_sec: f64) -> u32 {
    (duration_sec * RENDER_FPS).round().max(1.0) as u32
}

fn push_segment_input(args: &mut Vec<String>, segment: &VideoSegment, width: u32, height: u32) {
    if let Some(source) = &segment.source {
        if source.is_image {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-framerate".into());
            args.push(format!("{RENDER_FPS:.0}"));
            args.push("-t".into());
            args.push(format!("{:.3}", segment.duration_sec));
        }
        args.push("-i".into());
        args.push(source.path.display().to_string());
        return;
    }
    args.push("-f".into());
    args.push("lavfi".into());
    args.push("-i".into());
    args.push(format!(
        "color=c=black:s={width}x{height}:d={:.3}:rate={RENDER_FPS:.0}",
        segment.duration_sec
    ));
}

fn segment_chain(
    source: Option<&VideoSource>,
    duration_sec: f64,
    width: u32,
    height: u32,
    crop_w: u32,
    crop_h: u32,
) -> String {
    if let Some(source) = source {
        let frame = preview_frame_filter(width, height, crop_w, crop_h, source.framing);
        if source.is_image {
            return format!(
                "{frame},trim=duration={duration:.3},setpts=PTS-STARTPTS",
                duration = duration_sec
            );
        }
        let trim = format!(
            "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS",
            source.in_sec, source.out_sec
        );
        let timed = if (source.speed - 1.0).abs() >= 0.001 {
            format!("{trim},setpts=PTS/{:.6}", source.speed)
        } else {
            trim
        };
        let body = if source.reverse_trim {
            format!("{timed},reverse,{frame}")
        } else {
            format!("{timed},{frame}")
        };
        return format!(
            "{body},tpad=stop_mode=clone:stop_duration={:.3}",
            duration_sec
        );
    }
    "setsar=1,fps=30,format=yuv420p".into()
}

fn fragment_filter_complex(
    segments: &[VideoSegment],
    width: u32,
    height: u32,
    crop_w: u32,
    crop_h: u32,
) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(segments.len() + 1);
    for (idx, segment) in segments.iter().enumerate() {
        let chain = segment_chain(
            segment.source.as_ref(),
            segment.duration_sec,
            width,
            height,
            crop_w,
            crop_h,
        );
        parts.push(format!("[{idx}:v]{chain}[v{idx}]"));
    }
    if segments.len() == 1 {
        parts.push("[v0]null[vout]".into());
    } else {
        let labels: String = (0..segments.len()).map(|i| format!("[v{i}]")).collect();
        parts.push(format!(
            "{labels}concat=n={}:v=1:a=0[vout]",
            segments.len()
        ));
    }
    parts.join(";")
}

/// One FFmpeg process for the whole 2s slot — never concat-demuxer of temp pieces.
fn encode_segments_as_fragment(
    ffmpeg: &Path,
    segments: &[VideoSegment],
    width: u32,
    height: u32,
    crop_w: u32,
    crop_h: u32,
    duration_sec: f64,
    dest: &Path,
) -> Result<(), String> {
    let frames = fragment_frame_count(duration_sec);
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-nostdin".into()];
    for segment in segments {
        push_segment_input(&mut args, segment, width, height);
    }
    args.push("-filter_complex".into());
    args.push(fragment_filter_complex(
        segments, width, height, crop_w, crop_h,
    ));
    args.push("-map".into());
    args.push("[vout]".into());
    args.push("-an".into());
    args.push("-fps_mode".into());
    args.push("cfr".into());
    push_preview_x264(&mut args, frames);
    push_preview_fmp4_flags(&mut args);
    args.push("-frames:v".into());
    args.push(frames.to_string());
    args.push(dest.display().to_string());
    run_ffmpeg(ffmpeg, &args)
}

/// Encode one independently invalidatable preview fragment for `[start, start+dur)`.
/// Not a slice of a full-timeline render — only overlapping clips are used.
fn encode_preview_fragment(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    project_id: &str,
    clips: &[RenderTimelineClipInput],
    aspect_ratio: &str,
    start_sec: f64,
    duration_sec: f64,
    dest: &Path,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to bake timeline preview. Install with: brew install ffmpeg".to_string()
    })?;
    let (width, height) = preview_output_size(aspect_ratio);
    let (aw, ah) = aspect_parts(aspect_ratio);
    let (crop_w, crop_h) = fit_inside(PREVIEW_STAGE_W, PREVIEW_STAGE_H, aw, ah);
    let end_sec = start_sec + duration_sec;
    let windowed: Vec<RenderTimelineClipInput> = clips
        .iter()
        .filter(|clip| clip.end_sec > start_sec && clip.start_sec < end_sec)
        .cloned()
        .collect();
    let segments = build_video_segments(
        &windowed,
        paths,
        app,
        project_id,
        "_preview-frag",
        aspect_ratio,
        Some((start_sec, end_sec)),
    )?;
    if segments.is_empty() {
        return Err("Fragment window produced no video".into());
    }
    encode_segments_as_fragment(
        &ffmpeg,
        &segments,
        width,
        height,
        crop_w,
        crop_h,
        duration_sec,
        dest,
    )
}

fn prune_index_files(dir: &Path, index: u32, keep: &Path) {
    let prefix = format!("frag_{index:04}_");
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with(&prefix) && path != keep {
            let _ = fs::remove_file(path);
        }
    }
}

fn fingerprint_ok(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[tauri::command]
pub async fn library_bake_timeline_fragment(
    app: AppHandle,
    project_id: String,
    clips: Vec<RenderTimelineClipInput>,
    aspect_ratio: String,
    index: u32,
    start_sec: f64,
    duration_sec: f64,
    fingerprint: String,
) -> Result<TimelineFragmentBakeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !fingerprint_ok(&fingerprint) {
            return Err("Invalid fragment fingerprint".into());
        }
        if duration_sec <= 0.0 {
            return Err("Fragment duration must be positive".into());
        }
        let paths = default_paths()?;
        let dir = preview_dir(&paths, &project_id);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create timeline preview cache: {e}"))?;
        let dest = dir.join(format!("frag_{index:04}_{fingerprint}.mp4"));
        if dest.is_file() {
            return Ok(TimelineFragmentBakeResult {
                path: dest.display().to_string(),
                index,
                start_sec,
                duration_sec,
                fingerprint,
            });
        }
        let partial = dest.with_extension("partial.mp4");
        if partial.exists() {
            let _ = fs::remove_file(&partial);
        }
        encode_preview_fragment(
            &app,
            &paths,
            &project_id,
            &clips,
            &aspect_ratio,
            start_sec,
            duration_sec,
            &partial,
        )?;
        if !partial.is_file() {
            return Err("ffmpeg preview fragment produced no output".into());
        }
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }
        fs::rename(&partial, &dest)
            .map_err(|e| format!("Could not finalize preview fragment: {e}"))?;
        prune_index_files(&dir, index, &dest);
        Ok(TimelineFragmentBakeResult {
            path: dest.display().to_string(),
            index,
            start_sec,
            duration_sec,
            fingerprint,
        })
    })
    .await
    .map_err(|e| format!("Timeline preview fragment bake failed: {e}"))?
}

#[tauri::command]
pub async fn library_concat_timeline_fragments(
    project_id: String,
    paths: Vec<String>,
) -> Result<TimelineFragmentConcatResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Err("No fragments to concatenate".into());
        }
        let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
            "FFmpeg is required to concat timeline fragments. Install with: brew install ffmpeg"
                .to_string()
        })?;
        let parascene = default_paths()?;
        let dir = preview_dir(&parascene, &project_id);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create timeline preview cache: {e}"))?;
        let cache_root = fs::canonicalize(&dir)
            .map_err(|e| format!("Could not resolve timeline preview cache: {e}"))?;
        let mut files: Vec<PathBuf> = Vec::with_capacity(paths.len());
        for raw in &paths {
            let file = PathBuf::from(raw.trim());
            let canon = fs::canonicalize(&file)
                .map_err(|e| format!("Fragment missing: {e}"))?;
            if !canon.starts_with(&cache_root) {
                return Err("Refusing to concat a file outside the timeline preview cache".into());
            }
            files.push(canon);
        }
        let list_path = dir.join("export-concat.txt");
        let list_body = files
            .iter()
            .map(|p| concat_demixer_line(p))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&list_path, list_body + "\n")
            .map_err(|e| format!("Could not write fragment concat list: {e}"))?;
        let dest = dir.join("export-copy.mp4");
        let partial = dest.with_extension("partial.mp4");
        if partial.exists() {
            let _ = fs::remove_file(&partial);
        }
        let args = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-nostdin".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path.display().to_string(),
            "-c".into(),
            "copy".into(),
            "-movflags".into(),
            "+faststart".into(),
            partial.display().to_string(),
        ];
        run_ffmpeg(&ffmpeg, &args)?;
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }
        fs::rename(&partial, &dest)
            .map_err(|e| format!("Could not finalize fragment concat: {e}"))?;
        Ok(TimelineFragmentConcatResult {
            path: dest.display().to_string(),
        })
    })
    .await
    .map_err(|e| format!("Timeline fragment concat failed: {e}"))?
}

#[tauri::command]
pub async fn library_clear_timeline_fragments(project_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let dir = preview_dir(&paths, &project_id);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Could not clear timeline preview cache: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Clear timeline preview cache failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_sizes_stay_even_and_small() {
        assert_eq!(preview_output_size("16:9"), (960, 540));
        assert_eq!(preview_output_size("9:16"), (540, 960));
        assert_eq!(preview_output_size("1:1"), (540, 540));
        let (w, h) = preview_output_size("4:5");
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
        assert!(w * h < 1920 * 1080);
    }

    #[test]
    fn fingerprint_rejects_path_chars() {
        assert!(fingerprint_ok("a1b2c3d4"));
        assert!(!fingerprint_ok("../secret"));
        assert!(!fingerprint_ok(""));
    }

    #[test]
    fn multi_span_fragment_uses_filter_concat_not_file_concat() {
        let segments = vec![
            VideoSegment {
                duration_sec: 0.8,
                source: None,
            },
            VideoSegment {
                duration_sec: 1.2,
                source: None,
            },
        ];
        let graph = fragment_filter_complex(&segments, 960, 540, 960, 540);
        assert!(graph.contains("[0:v]"));
        assert!(graph.contains("[1:v]"));
        assert!(graph.contains("concat=n=2:v=1:a=0[vout]"));
    }
}
