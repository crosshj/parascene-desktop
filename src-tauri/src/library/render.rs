use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use super::reverse::ensure_reversed_media;
use super::slideshow::{ensure_slideshow, SlideshowEnsureInput};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSlideshowRecipe {
    pub image_asset_ids: Vec<String>,
    pub mode: String,
    #[serde(default)]
    pub random: Option<bool>,
    #[serde(default)]
    pub seed: Option<u32>,
    #[serde(default)]
    pub audio_asset_id: Option<String>,
    #[serde(default)]
    pub audio_in_sec: Option<f64>,
    #[serde(default)]
    pub audio_out_sec: Option<f64>,
    #[serde(default)]
    pub audio_start_sec: Option<f64>,
    #[serde(default)]
    pub audio_end_sec: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderTimelineClipInput {
    pub asset_id: Option<String>,
    pub start_sec: f64,
    pub end_sec: f64,
    pub lane: Option<String>,
    pub kind: Option<String>,
    pub in_sec: Option<f64>,
    pub out_sec: Option<f64>,
    #[serde(default)]
    pub include_audio: bool,
    #[serde(default)]
    pub reverse: bool,
    /// Match editor staging: fit (contain), fill (cover), stretch.
    #[serde(default)]
    pub framing: Option<String>,
    #[serde(default)]
    pub slideshow: Option<RenderSlideshowRecipe>,
    #[serde(default)]
    pub bake_key: Option<String>,
    #[serde(default)]
    pub bake_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRender {
    pub id: String,
    pub path: String,
    pub created_at: String,
    pub duration_sec: f64,
    pub aspect_ratio: String,
    pub clip_count: u32,
    #[serde(default)]
    pub command_line: String,
    #[serde(default = "ready_render_status")]
    pub status: String,
    #[serde(default)]
    pub progress: Option<RenderProgress>,
    #[serde(default)]
    pub error: Option<String>,
}

fn ready_render_status() -> String {
    "ready".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RenderManifest {
    renders: Vec<TimelineRender>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub project_id: String,
    pub render_id: String,
    pub phase: String,
    pub done: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderFinished {
    pub project_id: String,
    pub ok: bool,
    pub render_id: String,
    pub error: Option<String>,
}

static RENDER_MANIFEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn manifest_lock() -> &'static Mutex<()> {
    RENDER_MANIFEST_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Debug)]
struct VideoSegment {
    duration_sec: f64,
    source: Option<VideoSource>,
}

#[derive(Clone, Debug)]
struct VideoSource {
    path: PathBuf,
    in_sec: f64,
    out_sec: f64,
    is_image: bool,
    framing: Framing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Framing {
    Fit,
    Fill,
    Stretch,
}

#[derive(Clone, Debug)]
struct AudioSegment {
    path: PathBuf,
    in_sec: f64,
    out_sec: f64,
    delay_ms: u64,
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn path_under_root(root: &Path, stored: &str) -> Result<PathBuf, String> {
    let path = Path::new(stored);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Could not resolve library root: {e}"))?;
    let file_canon = candidate
        .canonicalize()
        .map_err(|e| format!("Local media missing or unreadable: {e}"))?;
    if !file_canon.starts_with(&root_canon) {
        return Err("Local media path is outside the Parascene library".into());
    }
    if !file_canon.is_file() {
        return Err("Local media file not found".into());
    }
    Ok(file_canon)
}

fn output_size(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (1080, 1080),
        "9:16" => (1080, 1920),
        "4:5" => (1080, 1350),
        _ => (1920, 1080),
    }
}

fn aspect_parts(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (1, 1),
        "9:16" => (9, 16),
        "4:5" => (4, 5),
        _ => (16, 9),
    }
}

/// Largest even aw:ah box that fits inside max_w×max_h (editor `fitAspect`).
fn fit_inside(max_w: u32, max_h: u32, aw: u32, ah: u32) -> (u32, u32) {
    if aw == 0 || ah == 0 {
        return (max_w & !1, max_h & !1);
    }
    let mut w = max_w as u64;
    let mut h = w * ah as u64 / aw as u64;
    if h > max_h as u64 {
        h = max_h as u64;
        w = h * aw as u64 / ah as u64;
    }
    ((w as u32) & !1, (h as u32) & !1)
}

/// Editor preview is always a 16:9 stage; project aspect is a centered matte crop.
const PREVIEW_STAGE_W: u32 = 1920;
const PREVIEW_STAGE_H: u32 = 1080;

fn clip_lane(lane: Option<&str>) -> &'static str {
    match lane.map(str::trim) {
        Some("audio") => "audio",
        _ => "video",
    }
}

fn clip_in_sec(in_sec: Option<f64>) -> f64 {
    in_sec
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0))
        .unwrap_or(0.0)
}

fn clip_out_sec(in_sec: f64, out_sec: Option<f64>, timeline_dur: f64) -> f64 {
    if let Some(out) = out_sec.filter(|v| v.is_finite()) {
        if out > in_sec {
            return out;
        }
    }
    in_sec + timeline_dur.max(0.1)
}

fn sequence_duration(clips: &[RenderTimelineClipInput]) -> f64 {
    clips
        .iter()
        .map(|c| c.end_sec)
        .filter(|v| v.is_finite())
        .fold(0.0_f64, f64::max)
}

fn renders_dir(paths: &ParascenePaths, project_id: &str) -> PathBuf {
    paths.cache.join("renders").join(safe_id(project_id))
}

fn manifest_path(paths: &ParascenePaths, project_id: &str) -> PathBuf {
    renders_dir(paths, project_id).join("manifest.json")
}

fn read_manifest(paths: &ParascenePaths, project_id: &str) -> Result<RenderManifest, String> {
    let path = manifest_path(paths, project_id);
    if !path.is_file() {
        return Ok(RenderManifest { renders: vec![] });
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("Could not read render manifest: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("Invalid render manifest: {e}"))
}

fn write_manifest(
    paths: &ParascenePaths,
    project_id: &str,
    manifest: &RenderManifest,
) -> Result<(), String> {
    let dir = renders_dir(paths, project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create render directory: {e}"))?;
    let path = manifest_path(paths, project_id);
    let raw = serde_json::to_string_pretty(manifest)
        .map_err(|e| format!("Could not serialize render manifest: {e}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, raw).map_err(|e| format!("Could not write render manifest: {e}"))?;
    fs::rename(&temp_path, &path).map_err(|e| format!("Could not replace render manifest: {e}"))
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let tail = err
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "ffmpeg render failed (exit {}): {}",
        output.status,
        if tail.is_empty() {
            "unknown error".into()
        } else {
            tail
        }
    ))
}

fn update_render<F>(
    paths: &ParascenePaths,
    project_id: &str,
    render_id: &str,
    update: F,
) -> Result<TimelineRender, String>
where
    F: FnOnce(&mut TimelineRender),
{
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(paths, project_id)?;
    let render = manifest
        .renders
        .iter_mut()
        .find(|render| render.id == render_id)
        .ok_or_else(|| format!("Render not found: {render_id}"))?;
    update(render);
    let updated = render.clone();
    write_manifest(paths, project_id, &manifest)?;
    Ok(updated)
}

fn emit_progress(
    app: &AppHandle,
    paths: &ParascenePaths,
    project_id: &str,
    render_id: &str,
    phase: &str,
    done: u32,
    total: u32,
) {
    let progress = RenderProgress {
        project_id: project_id.into(),
        render_id: render_id.into(),
        phase: phase.into(),
        done,
        total,
    };
    let _ = update_render(paths, project_id, render_id, |render| {
        render.progress = Some(progress.clone());
    });
    let _ = app.emit("publisher-render-progress", progress);
}

fn emit_finished(
    app: &AppHandle,
    project_id: &str,
    ok: bool,
    render_id: String,
    error: Option<String>,
) {
    let _ = app.emit(
        "publisher-render-finished",
        RenderFinished {
            project_id: project_id.into(),
            ok,
            render_id,
            error,
        },
    );
}

fn resolve_media_path(
    paths: &ParascenePaths,
    asset_id: &str,
    reverse: bool,
) -> Result<PathBuf, String> {
    let conn = ready_connection(paths)?;
    let creation = get_creation_by_id(&conn, asset_id)?
        .ok_or_else(|| format!("Creation not found: {asset_id}"))?;
    if reverse {
        return Ok(PathBuf::from(ensure_reversed_media(paths, &creation)?.path));
    }
    let local_path = creation
        .local_path
        .clone()
        .ok_or_else(|| format!("No local media on disk yet for {asset_id}"))?;
    path_under_root(&paths.root, &local_path)
}

fn is_image_clip(clip: &RenderTimelineClipInput, creation: Option<&Creation>) -> bool {
    if clip
        .kind
        .as_deref()
        .map(|k| k.eq_ignore_ascii_case("image"))
        .unwrap_or(false)
    {
        return true;
    }
    if let Some(c) = creation {
        return c.media_type.eq_ignore_ascii_case("image");
    }
    false
}

fn clip_framing(clip: &RenderTimelineClipInput) -> Framing {
    match clip.framing.as_deref().map(str::trim) {
        Some(value) if value.eq_ignore_ascii_case("fill") => Framing::Fill,
        Some(value) if value.eq_ignore_ascii_case("stretch") => Framing::Stretch,
        _ => Framing::Fit,
    }
}

/// Matches editor `clipCovering`: later clips in timeline order win when stacked.
fn video_clip_covering_index(
    lane_clips: &[&RenderTimelineClipInput],
    t: f64,
    sequence_end: f64,
) -> Option<usize> {
    let mut hit: Option<usize> = None;
    for (index, clip) in lane_clips.iter().enumerate() {
        if t >= clip.start_sec && t < clip.end_sec {
            hit = Some(index);
        }
    }
    if hit.is_some() {
        return hit;
    }
    if sequence_end > 0.0 && t >= sequence_end {
        for (index, clip) in lane_clips.iter().enumerate() {
            if (clip.end_sec - sequence_end).abs() < 1e-6 && t >= clip.start_sec {
                hit = Some(index);
            }
        }
    }
    hit
}

fn build_video_segments(
    clips: &[RenderTimelineClipInput],
    paths: &ParascenePaths,
    app: &AppHandle,
    project_id: &str,
    render_id: &str,
    aspect_ratio: &str,
) -> Result<Vec<VideoSegment>, String> {
    let total = sequence_duration(clips);
    if total <= 0.0 {
        return Err("Timeline has no duration".into());
    }

    // Preserve timeline array order — later entries render on top when overlapping.
    let lane_clips: Vec<&RenderTimelineClipInput> = clips
        .iter()
        .filter(|c| clip_lane(c.lane.as_deref()) == "video")
        .filter(|c| {
            let is_slideshow = c
                .kind
                .as_deref()
                .map(|k| k.eq_ignore_ascii_case("slideshow"))
                .unwrap_or(false)
                && c.slideshow
                    .as_ref()
                    .map(|s| s.image_asset_ids.len() >= 2)
                    .unwrap_or(false);
            is_slideshow
                || c.asset_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
        })
        .collect();

    let mut cuts: Vec<f64> = vec![0.0, total];
    for clip in &lane_clips {
        if clip.start_sec.is_finite() && clip.start_sec > 0.0 && clip.start_sec < total {
            cuts.push(clip.start_sec);
        }
        if clip.end_sec.is_finite() && clip.end_sec > 0.0 && clip.end_sec < total {
            cuts.push(clip.end_sec);
        }
    }
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    cuts.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    // Collapse into contiguous ranges where the same top clip wins.
    #[derive(Clone)]
    struct Range {
        start: f64,
        end: f64,
        clip_index: Option<usize>,
    }
    let mut ranges: Vec<Range> = Vec::new();
    for window in cuts.windows(2) {
        let start = window[0];
        let end = window[1];
        if end - start < 1e-6 {
            continue;
        }
        let mid = (start + end) * 0.5;
        let clip_index = video_clip_covering_index(&lane_clips, mid, total);
        if let Some(last) = ranges.last_mut() {
            if last.clip_index == clip_index {
                last.end = end;
                continue;
            }
        }
        ranges.push(Range {
            start,
            end,
            clip_index,
        });
    }

    let prepare_total = ranges.len().max(1) as u32;
    emit_progress(
        app,
        paths,
        project_id,
        render_id,
        "prepare",
        0,
        prepare_total,
    );

    let mut segments: Vec<VideoSegment> = Vec::with_capacity(ranges.len());
    for (index, range) in ranges.iter().enumerate() {
        let duration_sec = range.end - range.start;
        let Some(clip_index) = range.clip_index else {
            segments.push(VideoSegment {
                duration_sec,
                source: None,
            });
            emit_progress(
                app,
                paths,
                project_id,
                render_id,
                "prepare",
                (index + 1) as u32,
                prepare_total,
            );
            continue;
        };
        let clip = lane_clips[clip_index];
        let timeline_dur = (clip.end_sec - clip.start_sec).max(0.1);
        let in_sec = clip_in_sec(clip.in_sec);
        let out_sec = clip_out_sec(in_sec, clip.out_sec, timeline_dur);
        let local_offset = (range.start - clip.start_sec).max(0.0);
        let source_in = (in_sec + local_offset).min(out_sec);
        let source_out = (source_in + duration_sec).min(out_sec);

        if clip
            .kind
            .as_deref()
            .map(|k| k.eq_ignore_ascii_case("slideshow"))
            .unwrap_or(false)
        {
            let recipe = clip
                .slideshow
                .as_ref()
                .ok_or_else(|| "Slideshow clip is missing its recipe".to_string())?;
            let ensure_input = SlideshowEnsureInput {
                image_asset_ids: recipe.image_asset_ids.clone(),
                mode: recipe.mode.clone(),
                random: recipe.random,
                seed: recipe.seed,
                duration_sec: timeline_dur,
                framing: clip.framing.clone(),
                aspect_ratio: aspect_ratio.into(),
                clip_start_sec: clip.start_sec,
                audio_asset_id: recipe.audio_asset_id.clone(),
                audio_in_sec: recipe.audio_in_sec,
                audio_out_sec: recipe.audio_out_sec,
                audio_start_sec: recipe.audio_start_sec,
                audio_end_sec: recipe.audio_end_sec,
            };
            // Prefer a persisted bake when its key still matches this recipe.
            let expected_key = super::slideshow::bake_key_for(&ensure_input);
            let path = if clip.bake_key.as_deref() == Some(expected_key.as_str()) {
                if let Some(stored) = clip.bake_path.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    match PathBuf::from(stored).canonicalize() {
                        Ok(existing) if existing.is_file() => existing,
                        _ => PathBuf::from(ensure_slideshow(paths, &ensure_input)?.path),
                    }
                } else {
                    PathBuf::from(ensure_slideshow(paths, &ensure_input)?.path)
                }
            } else {
                PathBuf::from(ensure_slideshow(paths, &ensure_input)?.path)
            };
            segments.push(VideoSegment {
                duration_sec,
                source: Some(VideoSource {
                    path,
                    in_sec: local_offset.max(0.0),
                    out_sec: (local_offset + duration_sec).max(local_offset + 0.001),
                    is_image: false,
                    // Bake already framed; stretch into the segment frame.
                    framing: Framing::Stretch,
                }),
            });
        } else {
            let asset_id = clip.asset_id.as_deref().unwrap_or("").trim();
            let conn = ready_connection(paths)?;
            let creation = get_creation_by_id(&conn, asset_id)?;
            let path = resolve_media_path(paths, asset_id, clip.reverse)?;
            let is_image = is_image_clip(clip, creation.as_ref());
            segments.push(VideoSegment {
                duration_sec,
                source: Some(VideoSource {
                    path,
                    in_sec: source_in,
                    out_sec: if is_image {
                        source_in + duration_sec
                    } else {
                        source_out.max(source_in + 0.001)
                    },
                    is_image,
                    framing: clip_framing(clip),
                }),
            });
        }
        emit_progress(
            app,
            paths,
            project_id,
            render_id,
            "prepare",
            (index + 1) as u32,
            prepare_total,
        );
    }

    if segments.is_empty() {
        segments.push(VideoSegment {
            duration_sec: total,
            source: None,
        });
    }

    Ok(segments)
}

fn collect_audio_segments(
    clips: &[RenderTimelineClipInput],
    paths: &ParascenePaths,
) -> Result<Vec<AudioSegment>, String> {
    let mut out: Vec<AudioSegment> = Vec::new();
    for clip in clips {
        let on_audio_lane = clip_lane(clip.lane.as_deref()) == "audio";
        let include_from_video = clip_lane(clip.lane.as_deref()) == "video" && clip.include_audio;
        if !on_audio_lane && !include_from_video {
            continue;
        }
        let asset_id = clip
            .asset_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Audio clip is missing an asset id".to_string())?;
        let timeline_dur = (clip.end_sec - clip.start_sec).max(0.1);
        let in_sec = clip_in_sec(clip.in_sec);
        let out_sec = clip_out_sec(in_sec, clip.out_sec, timeline_dur);
        let source_dur = (out_sec - in_sec).min(timeline_dur);
        let path = resolve_media_path(paths, asset_id, clip.reverse)?;
        let delay_ms = (clip.start_sec.max(0.0) * 1000.0).round() as u64;
        out.push(AudioSegment {
            path,
            in_sec,
            out_sec: in_sec + source_dur,
            delay_ms,
        });
    }
    Ok(out)
}

fn frame_filter(out_w: u32, out_h: u32, crop_w: u32, crop_h: u32, framing: Framing) -> String {
    // Browsers size by pixel dimensions (ignore SAR/DAR).
    // Always end with fps + yuv420p so concat segments share one format/timebase.
    // (PNG stills are rgb/rgba; mixing those with yuv video mid-concat is a
    // common cause of "plays audio, freezes video until seek" in HW decoders.)
    let prefix = "setsar=1";
    // Deterministic 30fps clock is appended by the segment encoder.
    let tail = "fps=30,format=yuv420p";
    match framing {
        // Match editor TimelineMonitor: contain into the 16:9 preview stage, then
        // center-crop to the project aspect matte, then scale to the output size.
        // (A 1:1 clip in a 9:16 project fills height in the UI — not letterboxed.)
        Framing::Fit => format!(
            "{prefix},scale={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:force_original_aspect_ratio=decrease,pad={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:(ow-iw)/2:(oh-ih)/2:black,crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,scale={out_w}:{out_h},setsar=1,{tail}"
        ),
        // object-fit: cover into the final project frame
        Framing::Fill => format!(
            "{prefix},scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},setsar=1,{tail}"
        ),
        // object-fit: fill
        Framing::Stretch => {
            format!("{prefix},scale={out_w}:{out_h},setsar=1,{tail}")
        }
    }
}

fn shell_quote(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '+'))
    {
        return value.into();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn ffmpeg_command_line(ffmpeg: &Path, args: &[String]) -> String {
    std::iter::once(ffmpeg.display().to_string())
        .chain(args.iter().cloned())
        .map(|part| shell_quote(&part))
        .collect::<Vec<_>>()
        .join(" ")
}

fn concat_demixer_line(path: &Path) -> String {
    let raw = path.display().to_string();
    format!("file '{}'", raw.replace('\'', r"'\''"))
}

fn push_x264_encode(args: &mut Vec<String>) {
    // Keep the HTML <video> path boring for WebKit/VideoToolbox: constrained
    // baseline, closed GOPs, no CABAC/weighted preds, repeated headers + AUDs.
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push("20".into());
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
    args.push("30".into());
    args.push("-keyint_min".into());
    args.push("30".into());
    args.push("-sc_threshold".into());
    args.push("0".into());
    args.push("-x264-params".into());
    args.push(
        "keyint=30:min-keyint=30:scenecut=0:open-gop=0:repeat-headers=1:aud=1:cabac=0:8x8dct=0:weightp=0:weightb=0".into(),
    );
    args.push("-colorspace".into());
    args.push("bt709".into());
    args.push("-color_primaries".into());
    args.push("bt709".into());
    args.push("-color_trc".into());
    args.push("bt709".into());
    args.push("-color_range".into());
    args.push("tv".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
}

fn push_x264_segment_encode(args: &mut Vec<String>) {
    args.push("-an".into());
    push_x264_encode(args);
}

fn render_timeline_file(
    app: &AppHandle,
    paths: &ParascenePaths,
    project_id: &str,
    render_id: &str,
    aspect_ratio: &str,
    clips: &[RenderTimelineClipInput],
    output_path: &Path,
) -> Result<(f64, String), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to render timelines. Install with: brew install ffmpeg".to_string()
    })?;
    let (width, height) = output_size(aspect_ratio);
    let (aw, ah) = aspect_parts(aspect_ratio);
    let (crop_w, crop_h) = fit_inside(PREVIEW_STAGE_W, PREVIEW_STAGE_H, aw, ah);
    let duration_sec = sequence_duration(clips);
    if duration_sec <= 0.0 {
        return Err("Timeline has no clips to render".into());
    }

    let video_segments =
        build_video_segments(clips, paths, app, project_id, render_id, aspect_ratio)?;
    let audio_segments = collect_audio_segments(clips, paths)?;

    // Encode each visual span to its own CFR mp4, then concat + re-encode.
    // Stream-copying concat demuxer output still freezes Chromium/VideoToolbox
    // around cut boundaries even when software decode looks fine.
    let work_dir = output_path.with_extension("segments");
    if work_dir.exists() {
        let _ = fs::remove_dir_all(&work_dir);
    }
    fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Could not create segment workspace: {e}"))?;

    let seg_total = video_segments.len().max(1) as u32;
    let mut segment_paths: Vec<PathBuf> = Vec::with_capacity(video_segments.len());
    let mut logged_commands: Vec<String> = Vec::new();

    for (index, segment) in video_segments.iter().enumerate() {
        emit_progress(
            app,
            paths,
            project_id,
            render_id,
            "render",
            index as u32,
            seg_total + 1,
        );
        let seg_path = work_dir.join(format!("seg_{index:03}.mp4"));
        let mut args: Vec<String> = vec!["-y".into()];

        if let Some(source) = &segment.source {
            let frame = frame_filter(width, height, crop_w, crop_h, source.framing);
            if source.is_image {
                args.push("-loop".into());
                args.push("1".into());
                args.push("-framerate".into());
                args.push("30".into());
                args.push("-t".into());
                args.push(format!("{:.3}", segment.duration_sec));
                args.push("-i".into());
                args.push(source.path.display().to_string());
                args.push("-vf".into());
                args.push(format!(
                    "{frame},trim=duration={:.3},setpts=PTS-STARTPTS",
                    segment.duration_sec
                ));
            } else {
                args.push("-i".into());
                args.push(source.path.display().to_string());
                args.push("-vf".into());
                args.push(format!(
                    "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,{frame}",
                    source.in_sec, source.out_sec
                ));
            }
        } else {
            args.push("-f".into());
            args.push("lavfi".into());
            args.push("-i".into());
            args.push(format!(
                "color=c=black:s={width}x{height}:d={:.3}:rate=30",
                segment.duration_sec
            ));
            args.push("-vf".into());
            args.push("setsar=1,fps=30,format=yuv420p".into());
        }

        args.push("-fps_mode".into());
        args.push("cfr".into());
        push_x264_segment_encode(&mut args);
        // Exact frame count keeps concat demuxer A/V aligned (seconds×30).
        let frames = (segment.duration_sec * 30.0).round().max(1.0) as u32;
        args.push("-frames:v".into());
        args.push(frames.to_string());
        args.push(seg_path.display().to_string());

        logged_commands.push(ffmpeg_command_line(&ffmpeg, &args));
        run_ffmpeg(&ffmpeg, &args)?;
        if !seg_path.is_file() {
            return Err(format!(
                "Segment encode produced no file: {}",
                seg_path.display()
            ));
        }
        segment_paths.push(seg_path);
        emit_progress(
            app,
            paths,
            project_id,
            render_id,
            "render",
            (index + 1) as u32,
            seg_total + 1,
        );
    }

    let list_path = work_dir.join("concat.txt");
    let list_body = segment_paths
        .iter()
        .map(|p| concat_demixer_line(p))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&list_path, list_body + "\n")
        .map_err(|e| format!("Could not write concat list: {e}"))?;

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.display().to_string(),
    ];
    let mut filter_parts: Vec<String> = Vec::new();
    let mut audio_labels: Vec<String> = Vec::new();
    for (offset, segment) in audio_segments.iter().enumerate() {
        args.push("-i".into());
        args.push(segment.path.display().to_string());
        let idx = offset + 1; // 0 is the concat video input
        let delay = segment.delay_ms;
        filter_parts.push(format!(
            "[{idx}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,adelay={delay}|{delay}[a{idx}]",
            segment.in_sec, segment.out_sec
        ));
        audio_labels.push(format!("[a{idx}]"));
    }

    if !audio_labels.is_empty() {
        let mix_inputs = audio_labels.join("");
        filter_parts.push(format!(
            "{mix_inputs}amix=inputs={}:duration=longest:dropout_transition=0[aout]",
            audio_labels.len()
        ));
        args.push("-filter_complex".into());
        args.push(filter_parts.join(";"));
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("[aout]".into());
        // Re-encode the joined bitstream. Stream-copying concat demuxer output
        // leaves mid-file SPS/GOP seams that freeze Chromium's VideoToolbox path
        // (software decode still looks fine; scrubbing still works).
        push_x264_encode(&mut args);
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    } else {
        args.push("-map".into());
        args.push("0:v".into());
        push_x264_encode(&mut args);
        args.push("-an".into());
    }
    args.push("-fps_mode".into());
    args.push("cfr".into());
    args.push("-t".into());
    args.push(format!("{duration_sec:.3}"));
    args.push(output_path.display().to_string());

    logged_commands.push(ffmpeg_command_line(&ffmpeg, &args));
    run_ffmpeg(&ffmpeg, &args)?;
    if !output_path.is_file() {
        return Err("ffmpeg render produced no output file".into());
    }

    let _ = fs::remove_dir_all(&work_dir);
    emit_progress(
        app,
        paths,
        project_id,
        render_id,
        "render",
        seg_total + 1,
        seg_total + 1,
    );

    let command_line = format!(
        "# segment encode + concat re-encode ({} segments)\n{}",
        segment_paths.len(),
        logged_commands.join("\n\n")
    );
    Ok((duration_sec, command_line))
}

fn new_render_id() -> String {
    format!(
        "render-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
}

fn run_render(
    app: &AppHandle,
    project_id: &str,
    render_id: &str,
    aspect_ratio: &str,
    clips: Vec<RenderTimelineClipInput>,
) -> Result<TimelineRender, String> {
    let paths = default_paths()?;
    let dir = renders_dir(&paths, project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create render directory: {e}"))?;
    let filename = format!("{}.mp4", safe_id(render_id));
    let output_path = dir.join(&filename);
    let (duration_sec, command_line) = render_timeline_file(
        app,
        &paths,
        project_id,
        render_id,
        aspect_ratio,
        &clips,
        &output_path,
    )?;

    update_render(&paths, project_id, render_id, |render| {
        render.duration_sec = duration_sec;
        render.command_line = command_line;
        render.status = "ready".into();
        render.progress = None;
        render.error = None;
    })
}

fn create_pending_render(
    project_id: &str,
    aspect_ratio: &str,
    clips: &[RenderTimelineClipInput],
) -> Result<TimelineRender, String> {
    if clips.is_empty() {
        return Err("Timeline is empty".into());
    }
    let paths = default_paths()?;
    let id = new_render_id();
    let dir = renders_dir(&paths, project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create render directory: {e}"))?;
    let render = TimelineRender {
        id: id.clone(),
        path: dir
            .join(format!("{}.mp4", safe_id(&id)))
            .display()
            .to_string(),
        created_at: Utc::now().to_rfc3339(),
        duration_sec: sequence_duration(clips),
        aspect_ratio: aspect_ratio.into(),
        clip_count: clips.len() as u32,
        command_line: String::new(),
        status: "rendering".into(),
        progress: None,
        error: None,
    };

    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(&paths, project_id)?;
    manifest.renders.insert(0, render.clone());
    write_manifest(&paths, project_id, &manifest)?;
    Ok(render)
}

#[tauri::command]
pub async fn publisher_list_renders(project_id: String) -> Result<Vec<TimelineRender>, String> {
    let paths = default_paths()?;
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(&paths, &project_id)?;
    let before = manifest.renders.len();
    manifest
        .renders
        .retain(|render| render.status != "ready" || Path::new(&render.path).is_file());
    if manifest.renders.len() != before {
        write_manifest(&paths, &project_id, &manifest)?;
    }
    Ok(manifest.renders)
}

#[tauri::command]
pub async fn publisher_render_timeline(
    app: AppHandle,
    project_id: String,
    aspect_ratio: String,
    clips: Vec<RenderTimelineClipInput>,
) -> Result<TimelineRender, String> {
    let pending = create_pending_render(&project_id, &aspect_ratio, &clips)?;
    let app_for_block = app.clone();
    let project_for_block = project_id.clone();
    let render_id = pending.id.clone();
    let render_id_for_block = render_id.clone();
    let _task = tauri::async_runtime::spawn_blocking(move || {
        match run_render(
            &app_for_block,
            &project_for_block,
            &render_id_for_block,
            &aspect_ratio,
            clips,
        ) {
            Ok(_) => {
                emit_finished(
                    &app_for_block,
                    &project_for_block,
                    true,
                    render_id_for_block,
                    None,
                );
            }
            Err(error) => {
                if let Ok(paths) = default_paths() {
                    let _ =
                        update_render(&paths, &project_for_block, &render_id_for_block, |render| {
                            render.status = "failed".into();
                            render.progress = None;
                            render.error = Some(error.clone());
                        });
                }
                emit_finished(
                    &app_for_block,
                    &project_for_block,
                    false,
                    render_id_for_block,
                    Some(error),
                );
            }
        }
    });
    Ok(pending)
}

#[tauri::command]
pub async fn publisher_delete_render(project_id: String, render_id: String) -> Result<(), String> {
    let paths = default_paths()?;
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(&paths, &project_id)?;
    let Some(index) = manifest
        .renders
        .iter()
        .position(|render| render.id == render_id)
    else {
        return Err("Render not found".into());
    };
    if manifest.renders[index].status == "rendering" {
        return Err("Cannot delete a render while FFmpeg is running".into());
    }
    let render = manifest.renders.remove(index);
    if Path::new(&render.path).is_file() {
        fs::remove_file(&render.path).map_err(|e| format!("Could not delete render file: {e}"))?;
    }
    write_manifest(&paths, &project_id, &manifest)?;
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRenderResult {
    pub cancelled: bool,
    pub path: Option<String>,
}

fn sanitize_project_name(project_title: &str) -> String {
    let stem: String = project_title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if stem.is_empty() {
        "parascene-render".into()
    } else {
        stem
    }
}

fn render_extension(render: &TimelineRender) -> String {
    Path::new(&render.path)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_else(|| "mp4".into())
}

fn default_export_name(project_title: &str, render: &TimelineRender) -> String {
    let project = sanitize_project_name(project_title);
    let stamp = chrono::DateTime::parse_from_rfc3339(&render.created_at)
        .ok()
        .map(|dt| dt.format("%y%m%d_%H%M").to_string())
        .unwrap_or_else(|| "000000_0000".into());
    let extension = render_extension(render);
    format!("{project}.{stamp}.{extension}")
}

fn pick_export_destination(default_name: &str) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        pick_export_destination_macos(default_name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = default_name;
        Err("Save to disk is currently only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
fn pick_export_destination_macos(default_name: &str) -> Result<Option<PathBuf>, String> {
    // Native save panel via osascript (same approach as library import picker).
    let escaped = default_name.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"
try
  set theFile to choose file name with prompt "Save render" default name "{escaped}"
  return POSIX path of theFile
on error number -128
  return ""
end try
"#
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Could not open save dialog: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Save dialog failed: {err}"));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    let mut path = PathBuf::from(text);
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("mp4"))
        != Some(true)
    {
        path.set_extension("mp4");
    }
    Ok(Some(path))
}

#[tauri::command]
pub async fn publisher_export_render(
    project_id: String,
    render_id: String,
    project_title: String,
) -> Result<ExportRenderResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let render = {
            let _guard = manifest_lock()
                .lock()
                .map_err(|_| "Render manifest lock was poisoned".to_string())?;
            let manifest = read_manifest(&paths, &project_id)?;
            manifest
                .renders
                .iter()
                .find(|render| render.id == render_id)
                .cloned()
                .ok_or_else(|| "Render not found".to_string())?
        };
        if render.status != "ready" {
            return Err("Render is not ready to save".into());
        }
        if !Path::new(&render.path).is_file() {
            return Err("Render file is missing from disk".into());
        }

        let default_name = default_export_name(&project_title, &render);
        let Some(dest) = pick_export_destination(&default_name)? else {
            return Ok(ExportRenderResult {
                cancelled: true,
                path: None,
            });
        };

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create destination folder: {e}"))?;
        }
        fs::copy(&render.path, &dest).map_err(|e| format!("Could not save render: {e}"))?;

        Ok(ExportRenderResult {
            cancelled: false,
            path: Some(dest.display().to_string()),
        })
    })
    .await
    .map_err(|e| format!("Export task failed: {e}"))?
}
