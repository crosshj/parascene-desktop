use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::{self, resolve_ffmpeg};
use super::lab_audio::extend_clip_on_disk;
use super::crt_gpu::{self, apply_crt_preset_to_video};
use super::looks::{build_look_video_filter, RenderLooks};
use super::paths::ParascenePaths;
use super::reverse::ensure_reversed_media;
use super::slideshow::{ensure_slideshow, SlideshowEnsureInput};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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
    #[serde(default)]
    pub sensitivity: Option<f64>,
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
    /// Kept for wire compatibility; video audio is materialized as linked
    /// Master Audio companions before render.
    #[serde(default)]
    #[allow(dead_code)]
    pub include_audio: bool,
    /// Set on Master Audio companions linked to a video Include Audio clip.
    #[serde(default)]
    pub linked_video_clip_id: Option<String>,
    #[serde(default)]
    pub reverse: bool,
    /// Match editor staging: fit (contain), fill (cover), stretch.
    #[serde(default)]
    pub framing: Option<String>,
    #[serde(default)]
    pub slideshow: Option<RenderSlideshowRecipe>,
    #[serde(default)]
    /// Wire field from timeline clips; bake lookup uses `bake_path`.
    #[allow(dead_code)]
    pub bake_key: Option<String>,
    #[serde(default)]
    pub bake_path: Option<String>,
    #[serde(default)]
    pub extend_ping_pong: Option<bool>,
    #[serde(default)]
    pub extend_source_span_sec: Option<f64>,
    #[serde(default)]
    pub extend_bake_path: Option<String>,
    #[serde(default)]
    pub extend_bake_cover_sec: Option<f64>,
    #[serde(default)]
    pub speed: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRender {
    pub id: String,
    pub path: String,
    pub created_at: String,
    /// Set when the render leaves `rendering` (ready or failed).
    #[serde(default)]
    pub finished_at: Option<String>,
    pub duration_sec: f64,
    pub aspect_ratio: String,
    pub clip_count: u32,
    #[serde(default)]
    pub command_line: String,
    /// Human Look name baked into this render, if any (e.g. "TV").
    #[serde(default)]
    pub look_label: Option<String>,
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
    /// prepare | encode_segment | concat | render (legacy)
    pub phase: String,
    pub done: u32,
    pub total: u32,
    /// Human-readable status for the Hook UI.
    #[serde(default)]
    pub message: Option<String>,
    /// 1-based segment number while encoding clips; None on prepare/concat.
    #[serde(default)]
    pub segment_index: Option<u32>,
    #[serde(default)]
    pub segment_count: Option<u32>,
    #[serde(default)]
    pub segment_duration_sec: Option<f64>,
    #[serde(default)]
    pub timeline_duration_sec: Option<f64>,
    #[serde(default)]
    pub look_enabled: Option<bool>,
    /// Human Look name when enabled (e.g. "TV").
    #[serde(default)]
    pub look_label: Option<String>,
    /// FFmpeg command for the step currently running (or about to run).
    #[serde(default)]
    pub current_command: Option<String>,
}

impl RenderProgress {
    fn base(project_id: &str, render_id: &str, phase: &str, done: u32, total: u32) -> Self {
        Self {
            project_id: project_id.into(),
            render_id: render_id.into(),
            phase: phase.into(),
            done,
            total,
            message: None,
            segment_index: None,
            segment_count: None,
            segment_duration_sec: None,
            timeline_duration_sec: None,
            look_enabled: None,
            look_label: None,
            current_command: None,
        }
    }
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
    /// Play the trimmed span backwards (ping-pong pong segments).
    reverse_trim: bool,
    /// Playback rate applied after trim (1 = realtime). Extend bakes are already retimed.
    speed: f64,
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
    reverse_trim: bool,
    /// Playback rate applied after atrim (1 = realtime).
    speed: f64,
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

/// Export frame clock. Segments are CFR at this rate, so every cut has to land
/// on this grid or the concat drifts off it.
const RENDER_FPS: f64 = 30.0;

/// Interior video gaps under this length are closed instead of rendered black.
/// The editor snaps clip edges to 0.1s, so a shorter gap is a rounding sliver
/// the user could not have placed on purpose — and one black frame between two
/// clips reads as a flash.
const GAP_CLOSE_MAX_SEC: f64 = 0.1;

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

fn clip_trim_out_sec(clip: &RenderTimelineClipInput) -> f64 {
    let in_sec = clip_in_sec(clip.in_sec);
    clip_out_sec(in_sec, clip.out_sec, clip_timeline_duration(clip))
}

fn clip_source_trim_span(clip: &RenderTimelineClipInput) -> f64 {
    (clip_trim_out_sec(clip) - clip_in_sec(clip.in_sec)).max(0.1)
}

fn clip_extend_source_span(clip: &RenderTimelineClipInput) -> f64 {
    let trim = clip_source_trim_span(clip);
    // Frozen span must never exceed the live trim — stale values (e.g. frozen at
    // outSec before an in-point raise) would space loop/pong tiles farther apart
    // than the atrim media they emit, leaving silence holes in the mix.
    if let Some(span) = clip.extend_source_span_sec.filter(|v| v.is_finite() && *v > 0.0) {
        return span.min(trim).max(0.1);
    }
    trim
}

fn clip_speed(clip: &RenderTimelineClipInput) -> f64 {
    clip.speed
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.clamp(0.25, 8.0))
        .unwrap_or(1.0)
}

fn clip_playthrough_unit(clip: &RenderTimelineClipInput) -> f64 {
    (clip_extend_source_span(clip) / clip_speed(clip)).max(0.1)
}

fn clip_timeline_duration(clip: &RenderTimelineClipInput) -> f64 {
    (clip.end_sec - clip.start_sec).max(0.1)
}

fn clip_is_video_kind(clip: &RenderTimelineClipInput) -> bool {
    !clip
        .kind
        .as_deref()
        .map(|k| {
            k.eq_ignore_ascii_case("image")
                || k.eq_ignore_ascii_case("slideshow")
                || k.eq_ignore_ascii_case("audio")
        })
        .unwrap_or(false)
}

fn clip_is_video_extended(clip: &RenderTimelineClipInput) -> bool {
    if !clip_is_video_kind(clip) {
        return false;
    }
    clip_timeline_duration(clip) > clip_playthrough_unit(clip) + 1e-3
}

/// Match editor `clipSourceSec` for video clips (rate-aware loop/pong).
fn clip_source_sec_at_local(clip: &RenderTimelineClipInput, local: f64) -> f64 {
    let in_sec = clip_in_sec(clip.in_sec);
    let out_sec = clip_trim_out_sec(clip);
    let source_span = clip_extend_source_span(clip);
    let speed = clip_speed(clip);
    let timeline_dur = clip_timeline_duration(clip);
    let playthrough = source_span / speed;
    let local = local.max(0.0);
    let media_local = local * speed;

    if media_local <= source_span + 1e-6 || timeline_dur <= playthrough + 1e-6 {
        return (in_sec + media_local).min(out_sec).max(in_sec);
    }

    let extend_media = media_local - source_span;
    if clip.extend_ping_pong != Some(true) {
        return in_sec + (extend_media % source_span);
    }

    let segment = (extend_media / source_span).floor();
    let phase = extend_media % source_span;
    if (segment as i64).rem_euclid(2) == 0 {
        out_sec - phase
    } else {
        in_sec + phase
    }
}

fn extend_split_points(clip: &RenderTimelineClipInput) -> Vec<f64> {
    let timeline_dur = clip_timeline_duration(clip);
    let playthrough = clip_playthrough_unit(clip);
    let mut points = vec![0.0];
    let mut t = playthrough;
    while t < timeline_dur - 1e-6 {
        points.push(t);
        t += playthrough;
    }
    points.push(timeline_dur);
    points.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    points.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    points
}

fn resolve_extend_bake_path(
    clip: &RenderTimelineClipInput,
    paths: &ParascenePaths,
) -> Result<Option<PathBuf>, String> {
    if !clip_is_video_extended(clip) {
        return Ok(None);
    }

    let timeline_dur = clip_timeline_duration(clip);
    // The editor bakes loop/pong material from forward media, so a reversed clip
    // has to bake from the reversed file instead of reusing that stored path.
    if !clip.reverse {
        if let Some(stored) = clip
            .extend_bake_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let path = PathBuf::from(stored);
            if path.is_file() {
                if let Some(cover) =
                    clip.extend_bake_cover_sec.filter(|v| v.is_finite() && *v > 0.0)
                {
                    let needed = timeline_dur * clip_speed(clip);
                    if cover + 0.001 >= needed {
                        return Ok(Some(path));
                    }
                } else {
                    return Ok(Some(path));
                }
            }
        }
    }

    let asset_id = clip
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Extended video clip is missing an asset id".to_string())?;
    let source_path = resolve_media_path(paths, asset_id, clip.reverse)?;
    let in_sec = clip_in_sec(clip.in_sec);
    let out_sec = clip_trim_out_sec(clip);
    // Bake 1× loop/pong material long enough that cover/speed >= timeline.
    let source_span = clip_extend_source_span(clip);
    let speed = clip_speed(clip);
    let media_needed = timeline_dur * speed;
    let spans = (media_needed / source_span).ceil().max(1.0);
    let target = (spans * source_span * 1000.0).round() / 1000.0;
    let ping_pong = clip.extend_ping_pong == Some(true);
    let baked = extend_clip_on_disk(
        &source_path,
        ping_pong,
        target,
        Some(in_sec),
        Some(out_sec),
        None,
    )?;
    Ok(Some(baked))
}

fn prepare_extend_bakes(
    lane_clips: &[&RenderTimelineClipInput],
    paths: &ParascenePaths,
) -> Result<HashMap<usize, PathBuf>, String> {
    let mut map = HashMap::new();
    for (index, clip) in lane_clips.iter().enumerate() {
        if let Some(path) = resolve_extend_bake_path(clip, paths)? {
            map.insert(index, path);
        }
    }
    Ok(map)
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
    let output = ffmpeg::command(ffmpeg)
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

fn emit_progress_detail(
    app: &AppHandle,
    paths: &ParascenePaths,
    project_id: &str,
    render_id: &str,
    mut progress: RenderProgress,
) {
    progress.project_id = project_id.into();
    progress.render_id = render_id.into();
    let _ = update_render(paths, project_id, render_id, |render| {
        render.progress = Some(progress.clone());
    });
    // Keep IPC/events light — full FFmpeg command lines are multi‑KB and
    // repeatedly marshaling them into the webview beachballs the UI.
    if let Some(cmd) = progress.current_command.as_mut() {
        const MAX_UI_CMD: usize = 1_500;
        if cmd.len() > MAX_UI_CMD {
            let omitted = cmd.len() - MAX_UI_CMD;
            cmd.truncate(MAX_UI_CMD);
            cmd.push_str(&format!("\n# … {omitted} bytes omitted from live UI"));
        }
    }
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

/// One span of output where the same clip (or nothing, meaning black) is on top.
#[derive(Clone, Debug, PartialEq)]
struct VideoRange {
    start: f64,
    end: f64,
    clip_index: Option<usize>,
}

/// Split the video lane into contiguous spans on the export frame grid.
fn video_ranges(lane_clips: &[&RenderTimelineClipInput], total: f64) -> Vec<VideoRange> {
    let mut cuts: Vec<f64> = vec![0.0, total];
    for clip in lane_clips {
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
    let mut ranges: Vec<VideoRange> = Vec::new();
    for window in cuts.windows(2) {
        let start = window[0];
        let end = window[1];
        if end - start < 1e-6 {
            continue;
        }
        let mid = (start + end) * 0.5;
        let clip_index = video_clip_covering_index(lane_clips, mid, total);
        if let Some(last) = ranges.last_mut() {
            if last.clip_index == clip_index {
                last.end = end;
                continue;
            }
        }
        ranges.push(VideoRange {
            start,
            end,
            clip_index,
        });
    }

    // Close sub-snap interior gaps so the outgoing clip holds across them (via
    // the tpad fill on encode) rather than the concat cutting to black. Leading
    // and trailing black stay — those are real empty timeline, not slivers.
    let last_range_index = ranges.len().saturating_sub(1);
    let mut closed: Vec<VideoRange> = Vec::with_capacity(ranges.len());
    for (index, range) in ranges.into_iter().enumerate() {
        let is_interior_gap =
            range.clip_index.is_none() && index > 0 && index < last_range_index;
        if is_interior_gap && range.end - range.start < GAP_CLOSE_MAX_SEC {
            if let Some(prev) = closed.last_mut() {
                prev.end = range.end;
                continue;
            }
        }
        closed.push(range);
    }

    // Put every cut on the frame grid. Segments are encoded with a rounded frame
    // count, so unsnapped cuts make each segment round in isolation and the
    // concat drifts off the timeline.
    let mut snapped: Vec<VideoRange> = Vec::with_capacity(closed.len());
    let mut prev_end_frame: i64 = 0;
    for range in closed {
        let start_frame = prev_end_frame;
        let mut end_frame = (range.end * RENDER_FPS).round() as i64;
        if end_frame <= start_frame {
            // Shorter than one frame: clip content still earns a frame, but a gap
            // is dropped so it can't spend a black frame it never asked for. The
            // next range starts where this one would have, so nothing shifts.
            if range.clip_index.is_none() {
                continue;
            }
            end_frame = start_frame + 1;
        }
        prev_end_frame = end_frame;
        snapped.push(VideoRange {
            start: start_frame as f64 / RENDER_FPS,
            end: end_frame as f64 / RENDER_FPS,
            clip_index: range.clip_index,
        });
    }
    snapped
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

    let ranges = video_ranges(&lane_clips, total);

    let extend_bakes = prepare_extend_bakes(&lane_clips, paths)?;
    let prepare_total = ranges.len().max(1) as u32;
    emit_progress_detail(
        app,
        paths,
        project_id,
        render_id,
        RenderProgress {
            message: Some(format!(
                "Preparing clip sources (0 of {prepare_total})…"
            )),
            timeline_duration_sec: Some(total),
            ..RenderProgress::base(project_id, render_id, "prepare", 0, prepare_total)
        },
    );

    let mut segments: Vec<VideoSegment> = Vec::with_capacity(ranges.len());
    for (index, range) in ranges.iter().enumerate() {
        let duration_sec = range.end - range.start;
        let Some(clip_index) = range.clip_index else {
            segments.push(VideoSegment {
                duration_sec,
                source: None,
            });
            emit_progress_detail(
                app,
                paths,
                project_id,
                render_id,
                RenderProgress {
                    message: Some(format!(
                        "Prepared black gap {} of {prepare_total} ({:.1}s)",
                        index + 1,
                        duration_sec
                    )),
                    timeline_duration_sec: Some(total),
                    segment_index: Some((index + 1) as u32),
                    segment_count: Some(prepare_total),
                    segment_duration_sec: Some(duration_sec),
                    ..RenderProgress::base(
                        project_id,
                        render_id,
                        "prepare",
                        (index + 1) as u32,
                        prepare_total,
                    )
                },
            );
            continue;
        };
        let clip = lane_clips[clip_index];
        let in_sec = clip_in_sec(clip.in_sec);
        let out_sec = clip_trim_out_sec(clip);
        let local_offset = (range.start - clip.start_sec).max(0.0);
        let local_end = (range.end - clip.start_sec).max(0.0);

        if let Some(bake_path) = extend_bakes.get(&clip_index) {
            let speed = clip_speed(clip);
            // 1× bake timeline is media-domain; retimed via setpts on encode.
            let bake_in = local_offset * speed;
            let bake_out = (local_end * speed).max(bake_in + 0.001);
            segments.push(VideoSegment {
                duration_sec,
                source: Some(VideoSource {
                    path: bake_path.clone(),
                    in_sec: bake_in,
                    out_sec: bake_out,
                    is_image: false,
                    framing: clip_framing(clip),
                    reverse_trim: false,
                    speed,
                }),
            });
            emit_progress_detail(
                app,
                paths,
                project_id,
                render_id,
                RenderProgress {
                    message: Some(format!(
                        "Prepared extend bake {} of {prepare_total} ({:.1}s)",
                        index + 1,
                        duration_sec
                    )),
                    timeline_duration_sec: Some(total),
                    segment_index: Some((index + 1) as u32),
                    segment_count: Some(prepare_total),
                    segment_duration_sec: Some(duration_sec),
                    ..RenderProgress::base(
                        project_id,
                        render_id,
                        "prepare",
                        (index + 1) as u32,
                        prepare_total,
                    )
                },
            );
            continue;
        }

        let speed = clip_speed(clip);
        let source_in = if clip
            .kind
            .as_deref()
            .map(|k| {
                k.eq_ignore_ascii_case("slideshow") || k.eq_ignore_ascii_case("image")
            })
            .unwrap_or(false)
        {
            (in_sec + local_offset).min(out_sec)
        } else {
            clip_source_sec_at_local(clip, local_offset)
        };
        let source_out = if clip
            .kind
            .as_deref()
            .map(|k| {
                k.eq_ignore_ascii_case("slideshow") || k.eq_ignore_ascii_case("image")
            })
            .unwrap_or(false)
        {
            (source_in + duration_sec).min(out_sec)
        } else {
            clip_source_sec_at_local(clip, local_end).max(source_in + 0.001)
        };

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
            // Once rendered, a slideshow bake is immutable source media.
            // Timeline placement and in/out edits must reuse it just like a
            // normal video clip; recipe/framing edits clear bake_path upstream.
            let stored_path = clip
                .bake_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .and_then(|stored| PathBuf::from(stored).canonicalize().ok())
                .filter(|stored| stored.is_file());
            let path = if let Some(stored) = stored_path {
                stored
            } else {
                let ensure_input = SlideshowEnsureInput {
                    image_asset_ids: recipe.image_asset_ids.clone(),
                    mode: recipe.mode.clone(),
                    random: recipe.random,
                    seed: recipe.seed,
                    duration_sec: out_sec.max(clip_timeline_duration(clip)),
                    framing: clip.framing.clone(),
                    aspect_ratio: aspect_ratio.into(),
                    clip_start_sec: clip.start_sec - in_sec,
                    audio_asset_id: recipe.audio_asset_id.clone(),
                    audio_in_sec: recipe.audio_in_sec,
                    audio_out_sec: recipe.audio_out_sec,
                    audio_start_sec: recipe.audio_start_sec,
                    audio_end_sec: recipe.audio_end_sec,
                    sensitivity: recipe.sensitivity,
                };
                PathBuf::from(ensure_slideshow(paths, &ensure_input)?.path)
            };
            segments.push(VideoSegment {
                duration_sec,
                source: Some(VideoSource {
                    path,
                    in_sec: source_in,
                    out_sec: source_out.max(source_in + 0.001),
                    is_image: false,
                    // Bake already framed; stretch into the segment frame.
                    framing: Framing::Stretch,
                    reverse_trim: false,
                    speed: 1.0,
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
                    reverse_trim: false,
                    speed: if is_image { 1.0 } else { speed },
                }),
            });
        }
        emit_progress_detail(
            app,
            paths,
            project_id,
            render_id,
            RenderProgress {
                message: Some(format!(
                    "Prepared source {} of {prepare_total} ({:.1}s)",
                    index + 1,
                    duration_sec
                )),
                timeline_duration_sec: Some(total),
                segment_index: Some((index + 1) as u32),
                segment_count: Some(prepare_total),
                segment_duration_sec: Some(duration_sec),
                ..RenderProgress::base(
                    project_id,
                    render_id,
                    "prepare",
                    (index + 1) as u32,
                    prepare_total,
                )
            },
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

fn audio_segment_reverse_trim(clip: &RenderTimelineClipInput, local_start: f64, local_end: f64) -> bool {
    let playthrough = clip_playthrough_unit(clip);
    if clip.extend_ping_pong != Some(true) || local_end <= playthrough + 1e-6 {
        return false;
    }
    let mid = (local_start + local_end) * 0.5;
    let extend_local = mid - playthrough;
    if extend_local <= 1e-6 {
        return false;
    }
    let segment = (extend_local / playthrough).floor() as i64;
    segment.rem_euclid(2) == 0
}

fn atempo_filter_chain(speed: f64) -> Option<String> {
    if !(speed.is_finite() && speed > 0.0) || (speed - 1.0).abs() < 0.001 {
        return None;
    }
    let mut remaining = speed.clamp(0.25, 8.0);
    let mut parts: Vec<String> = Vec::new();
    while remaining > 2.0 + 1e-9 {
        parts.push("atempo=2.0".into());
        remaining /= 2.0;
    }
    while remaining < 0.5 - 1e-9 {
        parts.push("atempo=0.5".into());
        remaining *= 2.0;
    }
    if (remaining - 1.0).abs() >= 0.001 {
        parts.push(format!("atempo={remaining:.6}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    }
}

fn clip_is_linked_video_audio(clip: &RenderTimelineClipInput) -> bool {
    clip.linked_video_clip_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
        && clip_lane(clip.lane.as_deref()) == "audio"
}

fn clip_uses_extended_audio(clip: &RenderTimelineClipInput) -> bool {
    let extended =
        clip_timeline_duration(clip) > clip_playthrough_unit(clip) + 1e-3;
    if !extended {
        return false;
    }
    // Video Include Audio companions (and legacy video-lane audio) tile loop/pong.
    // Reverse is OK: media path is the reversed bake; tiles still map on that file.
    clip_is_video_extended(clip) || clip_is_linked_video_audio(clip)
}

/// One atrim(/areverse) tile planned from a clip — path resolved separately.
#[derive(Clone, Debug, PartialEq)]
struct PlannedAudioTile {
    in_sec: f64,
    out_sec: f64,
    /// Offset from clip.start_sec where this tile begins on the timeline.
    local_start: f64,
    reverse_trim: bool,
    speed: f64,
}

/// Plan loop / ping-pong / trim tiles without touching the filesystem.
///
/// Each tile's media window is derived from the tile duration (not by sampling
/// `clip_source_sec` at endpoints — that mis-handles loop boundaries and
/// produced wrong media + timeline gaps on partial last tiles).
fn plan_clip_audio_tiles(clip: &RenderTimelineClipInput) -> Vec<PlannedAudioTile> {
    let speed = clip_speed(clip);
    let in_sec = clip_in_sec(clip.in_sec);
    let out_sec = clip_trim_out_sec(clip);
    let source_span = clip_extend_source_span(clip);

    if clip_uses_extended_audio(clip) {
        let points = extend_split_points(clip);
        let mut tiles = Vec::new();
        for window in points.windows(2) {
            let local_start = window[0];
            let local_end = window[1];
            let tile_dur = local_end - local_start;
            if tile_dur < 1e-6 {
                continue;
            }
            let media_len = (tile_dur * speed).min(source_span);
            if media_len < 1e-6 {
                continue;
            }
            // Ping-pong reverse tiles: odd segments past the first playthrough.
            let reverse_trim = audio_segment_reverse_trim(clip, local_start, local_end);
            let (seg_in, seg_out) = if reverse_trim {
                ((out_sec - media_len).max(in_sec), out_sec)
            } else {
                (in_sec, (in_sec + media_len).min(out_sec))
            };
            if seg_out - seg_in < 1e-6 {
                continue;
            }
            tiles.push(PlannedAudioTile {
                in_sec: seg_in,
                out_sec: seg_out,
                local_start,
                reverse_trim,
                speed,
            });
        }
        return tiles;
    }

    let timeline_dur = clip_timeline_duration(clip);
    let media_dur = (timeline_dur * speed).min(out_sec - in_sec).max(0.001);
    vec![PlannedAudioTile {
        in_sec,
        out_sec: in_sec + media_dur,
        local_start: 0.0,
        reverse_trim: false,
        speed,
    }]
}

fn audio_segment_timeline_range(seg: &AudioSegment) -> (f64, f64) {
    let start = seg.delay_ms as f64 / 1000.0;
    let dur = ((seg.out_sec - seg.in_sec) / seg.speed.max(0.001)).max(0.0);
    (start, start + dur)
}

fn merge_timeline_ranges(mut ranges: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    if ranges.is_empty() {
        return ranges;
    }
    ranges.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = vec![ranges[0]];
    for (a, b) in ranges.into_iter().skip(1) {
        let last = out.last_mut().expect("out non-empty");
        if a <= last.1 + 1e-3 {
            last.1 = last.1.max(b);
        } else {
            out.push((a, b));
        }
    }
    out
}

/// Remove bed coverage that overlaps priority (linked video audio) spans.
fn punch_bed_around_priority(
    bed: Vec<AudioSegment>,
    priority: &[AudioSegment],
) -> Vec<AudioSegment> {
    if priority.is_empty() || bed.is_empty() {
        return bed;
    }
    let priority_ranges = merge_timeline_ranges(
        priority
            .iter()
            .map(audio_segment_timeline_range)
            .filter(|(a, b)| b - a > 1e-4)
            .collect(),
    );

    let mut out = Vec::new();
    for seg in bed {
        let (mut cursor, end) = audio_segment_timeline_range(&seg);
        if end - cursor <= 1e-4 {
            continue;
        }
        let speed = seg.speed.max(0.001);
        for &(p0, p1) in &priority_ranges {
            if p1 <= cursor + 1e-4 || p0 >= end - 1e-4 {
                continue;
            }
            let gap_end = p0.clamp(cursor, end);
            if gap_end - cursor > 1e-4 {
                let media_start = seg.in_sec + (cursor - (seg.delay_ms as f64 / 1000.0)) * speed;
                let media_end = seg.in_sec + (gap_end - (seg.delay_ms as f64 / 1000.0)) * speed;
                out.push(AudioSegment {
                    path: seg.path.clone(),
                    in_sec: media_start.min(media_end),
                    out_sec: media_start.max(media_end),
                    delay_ms: (cursor * 1000.0).round() as u64,
                    reverse_trim: seg.reverse_trim,
                    speed: seg.speed,
                });
            }
            cursor = p1.clamp(cursor, end);
        }
        if end - cursor > 1e-4 {
            let media_start = seg.in_sec + (cursor - (seg.delay_ms as f64 / 1000.0)) * speed;
            let media_end = seg.in_sec + (end - (seg.delay_ms as f64 / 1000.0)) * speed;
            out.push(AudioSegment {
                path: seg.path.clone(),
                in_sec: media_start.min(media_end),
                out_sec: media_start.max(media_end),
                delay_ms: (cursor * 1000.0).round() as u64,
                reverse_trim: seg.reverse_trim,
                speed: seg.speed,
            });
        }
    }
    out
}

fn expand_clip_audio_segments(
    clip: &RenderTimelineClipInput,
    paths: &ParascenePaths,
) -> Result<Vec<AudioSegment>, String> {
    let asset_id = clip
        .asset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Audio clip is missing an asset id".to_string())?;
    let path = resolve_media_path(paths, asset_id, clip.reverse)?;
    let delay_base = clip.start_sec.max(0.0);
    Ok(plan_clip_audio_tiles(clip)
        .into_iter()
        .map(|tile| AudioSegment {
            path: path.clone(),
            in_sec: tile.in_sec,
            out_sec: tile.out_sec,
            delay_ms: ((delay_base + tile.local_start) * 1000.0).round() as u64,
            reverse_trim: tile.reverse_trim,
            speed: tile.speed,
        })
        .collect())
}

fn collect_audio_segments(
    clips: &[RenderTimelineClipInput],
    paths: &ParascenePaths,
) -> Result<Vec<AudioSegment>, String> {
    // Video Include Audio is materialized as linked Master Audio companions
    // (see syncLinkedVideoAudio / timelineClipsToRenderInput). Collect only the
    // audio lane; linked companions take precedence over bed audio.
    let mut priority: Vec<AudioSegment> = Vec::new();
    let mut bed: Vec<AudioSegment> = Vec::new();

    for clip in clips {
        if clip_lane(clip.lane.as_deref()) != "audio" {
            continue;
        }
        let segments = expand_clip_audio_segments(clip, paths)?;
        if clip_is_linked_video_audio(clip) {
            priority.extend(segments);
        } else {
            bed.extend(segments);
        }
    }

    let bed = punch_bed_around_priority(bed, &priority);
    let mut out = priority;
    out.extend(bed);
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

/// Intermediate concat when a GPU Look will re-encode the final file.
/// Stream-copy the already-uniform segment bitstreams — skip a full CPU x264 pass.
fn push_gpu_look_intermediate_video(args: &mut Vec<String>) {
    args.push("-c:v".into());
    args.push("copy".into());
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
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
    looks: &RenderLooks,
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
    let look_on = looks.has_any_enabled();
    let look_label = looks.enabled_label().map(str::to_string);

    for (index, segment) in video_segments.iter().enumerate() {
        let seg_num = (index + 1) as u32;
        emit_progress_detail(
            app,
            paths,
            project_id,
            render_id,
            RenderProgress {
                message: Some(format!(
                    "Encoding segment {seg_num} of {seg_total} ({:.1}s)…",
                    segment.duration_sec
                )),
                segment_index: Some(seg_num),
                segment_count: Some(seg_total),
                segment_duration_sec: Some(segment.duration_sec),
                timeline_duration_sec: Some(duration_sec),
                look_enabled: Some(look_on),
                look_label: look_label.clone(),
                ..RenderProgress::base(
                    project_id,
                    render_id,
                    "encode_segment",
                    index as u32,
                    seg_total + 1,
                )
            },
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
                // A source too short for its slot would end the segment early, and
                // concat would then pull every later clip ahead of where the
                // timeline puts it. Hold the last frame instead; -frames:v trims
                // the surplus. tpad needs the CFR link that frame_filter ends on.
                args.push(format!(
                    "{body},tpad=stop_mode=clone:stop_duration={:.3}",
                    segment.duration_sec
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

        let command = ffmpeg_command_line(&ffmpeg, &args);
        logged_commands.push(command.clone());
        emit_progress_detail(
            app,
            paths,
            project_id,
            render_id,
            RenderProgress {
                message: Some(format!(
                    "Encoding segment {seg_num} of {seg_total} ({:.1}s)…",
                    segment.duration_sec
                )),
                segment_index: Some(seg_num),
                segment_count: Some(seg_total),
                segment_duration_sec: Some(segment.duration_sec),
                timeline_duration_sec: Some(duration_sec),
                look_enabled: Some(look_on),
                look_label: look_label.clone(),
                current_command: Some(command),
                ..RenderProgress::base(
                    project_id,
                    render_id,
                    "encode_segment",
                    index as u32,
                    seg_total + 1,
                )
            },
        );
        run_ffmpeg(&ffmpeg, &args)?;
        if !seg_path.is_file() {
            return Err(format!(
                "Segment encode produced no file: {}",
                seg_path.display()
            ));
        }
        segment_paths.push(seg_path);
        emit_progress_detail(
            app,
            paths,
            project_id,
            render_id,
            RenderProgress {
                message: Some(format!(
                    "Finished segment {seg_num} of {seg_total}"
                )),
                segment_index: Some(seg_num),
                segment_count: Some(seg_total),
                segment_duration_sec: Some(segment.duration_sec),
                timeline_duration_sec: Some(duration_sec),
                look_enabled: Some(look_on),
                look_label: look_label.clone(),
                ..RenderProgress::base(
                    project_id,
                    render_id,
                    "encode_segment",
                    seg_num,
                    seg_total + 1,
                )
            },
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
        let trim = format!(
            "[{idx}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS",
            segment.in_sec, segment.out_sec
        );
        let tempo = atempo_filter_chain(segment.speed)
            .map(|c| format!(",{c}"))
            .unwrap_or_default();
        let chain = if segment.reverse_trim {
            format!("{trim}{tempo},areverse,adelay={delay}|{delay}[a{idx}]")
        } else {
            format!("{trim}{tempo},adelay={delay}|{delay}[a{idx}]")
        };
        filter_parts.push(chain);
        audio_labels.push(format!("[a{idx}]"));
    }

    let gpu_preset = if crt_gpu::crt_gpu_available() {
        looks.crt_preset()
    } else {
        None
    };
    // Prefer GPU CRT (fast). FFmpeg TV graph is CPU fallback only.
    let look_graph = if gpu_preset.is_some() {
        None
    } else {
        build_look_video_filter(looks, "0:v", "vout")
    };
    if looks.has_any_enabled() && gpu_preset.is_none() && look_graph.is_none() {
        return Err(
            "Afterglow and Broadcast require GPU acceleration. Enable TV for the CPU fallback, or check GPU drivers."
                .into(),
        );
    }
    if let Some(ref graph) = look_graph {
        filter_parts.insert(0, graph.clone());
    }

    // GPU Look re-encodes the final file — don't pay a full baseline x264 concat first.
    let gpu_intermediate = gpu_preset.is_some();

    if !audio_labels.is_empty() {
        let mix_inputs = audio_labels.join("");
        filter_parts.push(format!(
            "{mix_inputs}amix=inputs={}:duration=longest:dropout_transition=0[aout]",
            audio_labels.len()
        ));
        args.push("-filter_complex".into());
        args.push(filter_parts.join(";"));
        args.push("-map".into());
        if look_graph.is_some() {
            args.push("[vout]".into());
        } else {
            args.push("0:v".into());
        }
        args.push("-map".into());
        args.push("[aout]".into());
        if gpu_intermediate {
            push_gpu_look_intermediate_video(&mut args);
        } else {
            // Re-encode the joined bitstream. Stream-copying concat demuxer output
            // leaves mid-file SPS/GOP seams that freeze Chromium's VideoToolbox path
            // (software decode still looks fine; scrubbing still works).
            push_x264_encode(&mut args);
        }
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    } else if look_graph.is_some() {
        args.push("-filter_complex".into());
        args.push(filter_parts.join(";"));
        args.push("-map".into());
        args.push("[vout]".into());
        push_x264_encode(&mut args);
        args.push("-an".into());
    } else if gpu_intermediate {
        args.push("-map".into());
        args.push("0:v".into());
        push_gpu_look_intermediate_video(&mut args);
        args.push("-an".into());
    } else {
        args.push("-map".into());
        args.push("0:v".into());
        push_x264_encode(&mut args);
        args.push("-an".into());
    }
    if !gpu_intermediate {
        args.push("-fps_mode".into());
        args.push("cfr".into());
    }
    args.push("-t".into());
    args.push(format!("{duration_sec:.3}"));
    // Write to a temp path, then rename — so a final output file only appears
    // when concat fully succeeds (hot-reload mid-write can't leave a half file
    // marked as the finished path).
    let partial_path = output_path.with_extension("partial.mp4");
    if partial_path.exists() {
        let _ = fs::remove_file(&partial_path);
    }
    args.push(partial_path.display().to_string());

    let concat_command = ffmpeg_command_line(&ffmpeg, &args);
    logged_commands.push(concat_command.clone());
    let concat_message = if gpu_intermediate {
        format!(
            "Joining segments ({duration_sec:.1}s, {seg_total} segments) for {} Look…",
            look_label.as_deref().unwrap_or("GPU")
        )
    } else if look_graph.is_some() {
        format!(
            "Final concat re-encode ({duration_sec:.1}s, {seg_total} segments) with FFmpeg TV Look…"
        )
    } else {
        format!("Final concat re-encode ({duration_sec:.1}s, {seg_total} segments)…")
    };
    emit_progress_detail(
        app,
        paths,
        project_id,
        render_id,
        RenderProgress {
            message: Some(concat_message),
            segment_count: Some(seg_total),
            timeline_duration_sec: Some(duration_sec),
            look_enabled: Some(look_on),
            look_label: look_label.clone(),
            current_command: Some(concat_command),
            ..RenderProgress::base(
                project_id,
                render_id,
                "concat",
                seg_total,
                seg_total + 1,
            )
        },
    );
    run_ffmpeg(&ffmpeg, &args)?;
    if !partial_path.is_file() {
        return Err("ffmpeg render produced no output file".into());
    }
    if output_path.exists() {
        let _ = fs::remove_file(output_path);
    }
    fs::rename(&partial_path, output_path).map_err(|e| {
        format!(
            "Could not finalize render output ({} → {}): {e}",
            partial_path.display(),
            output_path.display()
        )
    })?;

    if let Some(preset) = gpu_preset {
        emit_progress_detail(
            app,
            paths,
            project_id,
            render_id,
            RenderProgress {
                message: Some(format!(
                    "Applying {} Look on GPU…",
                    look_label.as_deref().unwrap_or(preset.as_str())
                )),
                segment_count: Some(seg_total),
                timeline_duration_sec: Some(duration_sec),
                look_enabled: Some(true),
                look_label: look_label.clone(),
                current_command: Some(format!(
                    "# GPU CRT Look ({}) via wgpu — FFmpeg concat finished",
                    preset.as_str()
                )),
                ..RenderProgress::base(
                    project_id,
                    render_id,
                    "concat",
                    seg_total,
                    seg_total + 1,
                )
            },
        );
        let shaded = output_path.with_extension("crt-shaded.mp4");
        let _ = fs::remove_file(&shaded);
        apply_crt_preset_to_video(output_path, &shaded, preset).map_err(|e| {
            let _ = fs::remove_file(&shaded);
            e
        })?;
        let _ = fs::remove_file(output_path);
        fs::rename(&shaded, output_path)
            .map_err(|e| format!("Could not finalize GPU CRT output: {e}"))?;
        logged_commands.push(format!(
            "# GPU CRT Look ({}) via wgpu",
            preset.as_str()
        ));
    }

    let _ = fs::remove_dir_all(&work_dir);
    emit_progress_detail(
        app,
        paths,
        project_id,
        render_id,
        RenderProgress {
            message: Some("Render finished".into()),
            segment_count: Some(seg_total),
            timeline_duration_sec: Some(duration_sec),
            look_enabled: Some(look_on),
            look_label: look_label.clone(),
            ..RenderProgress::base(
                project_id,
                render_id,
                "concat",
                seg_total + 1,
                seg_total + 1,
            )
        },
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
    looks: RenderLooks,
) -> Result<TimelineRender, String> {
    let paths = default_paths()?;
    let dir = renders_dir(&paths, project_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create render directory: {e}"))?;
    let filename = format!("{}.mp4", safe_id(render_id));
    let output_path = dir.join(&filename);
    // Surface progress immediately so the UI doesn't sit on "Starting FFmpeg…"
    // while reverse/extend prep or the first segment encode runs.
    emit_progress_detail(
        app,
        &paths,
        project_id,
        render_id,
        RenderProgress {
            message: Some("Preparing timeline sources…".into()),
            ..RenderProgress::base(project_id, render_id, "prepare", 0, 1)
        },
    );
    let (duration_sec, command_line) = render_timeline_file(
        app,
        &paths,
        project_id,
        render_id,
        aspect_ratio,
        &clips,
        &looks,
        &output_path,
    )?;

    match update_render(&paths, project_id, render_id, |render| {
        render.duration_sec = duration_sec;
        render.command_line = command_line.clone();
        render.status = "ready".into();
        render.finished_at = Some(Utc::now().to_rfc3339());
        render.progress = None;
        render.error = None;
    }) {
        Ok(updated) => Ok(updated),
        Err(_) => {
            // Entry may have been deleted mid-render; re-insert as ready so the
            // finished file is not orphaned from the Publisher list.
            let _guard = manifest_lock()
                .lock()
                .map_err(|_| "Render manifest lock was poisoned".to_string())?;
            let mut manifest = read_manifest(&paths, project_id)?;
            let render = TimelineRender {
                id: render_id.into(),
                path: output_path.display().to_string(),
                created_at: Utc::now().to_rfc3339(),
                finished_at: Some(Utc::now().to_rfc3339()),
                duration_sec,
                aspect_ratio: aspect_ratio.into(),
                clip_count: clips.len() as u32,
                command_line,
                look_label: looks.enabled_label().map(str::to_string),
                status: "ready".into(),
                progress: None,
                error: None,
            };
            manifest.renders.insert(0, render.clone());
            write_manifest(&paths, project_id, &manifest)?;
            Ok(render)
        }
    }
}

fn create_pending_render(
    project_id: &str,
    aspect_ratio: &str,
    clips: &[RenderTimelineClipInput],
    looks: &RenderLooks,
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
        finished_at: None,
        duration_sec: sequence_duration(clips),
        aspect_ratio: aspect_ratio.into(),
        clip_count: clips.len() as u32,
        command_line: String::new(),
        look_label: looks.enabled_label().map(str::to_string),
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
    let heal_id = project_id.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || list_renders_light(&project_id))
        .await
        .map_err(|e| format!("List renders task failed: {e}"))??;
    // Heavy abandoned-job cleanup must not gate the tab open path.
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || heal_abandoned_renders(&heal_id)).await;
    });
    Ok(rows)
}

#[tauri::command]
pub async fn publisher_get_render(
    project_id: String,
    render_id: String,
) -> Result<TimelineRender, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let _guard = manifest_lock()
            .lock()
            .map_err(|_| "Render manifest lock was poisoned".to_string())?;
        let manifest = read_manifest(&paths, &project_id)?;
        manifest
            .renders
            .into_iter()
            .find(|render| render.id == render_id)
            .ok_or_else(|| "Render not found".into())
    })
    .await
    .map_err(|e| format!("Get render task failed: {e}"))?
}

fn file_mtime_age_secs(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()
        .map(|age| age.as_secs())
}

/// Youngest (most recently written) age among existing workspace artifacts.
fn workspace_newest_write_age_secs(partial: &Path, segments_dir: &Path) -> Option<u64> {
    let mut newest: Option<u64> = None;
    let consider = |age: Option<u64>, newest: &mut Option<u64>| {
        if let Some(a) = age {
            *newest = Some(match *newest {
                Some(n) => n.min(a),
                None => a,
            });
        }
    };
    if partial.is_file() {
        consider(file_mtime_age_secs(partial), &mut newest);
    }
    // Only the directory mtime — walking every segment file on each list call
    // was unnecessarily heavy for Publisher tab opens.
    if segments_dir.is_dir() {
        consider(file_mtime_age_secs(segments_dir), &mut newest);
    }
    newest
}

fn slim_render_for_list(render: &mut TimelineRender) {
    render.command_line.clear();
    if let Some(progress) = render.progress.as_mut() {
        progress.current_command = None;
    }
}

/// Fast path for Publisher tab open: read manifest, drop missing ready files,
/// return UI-sized rows. Abandoned-job heal runs separately.
fn list_renders_light(project_id: &str) -> Result<Vec<TimelineRender>, String> {
    let paths = default_paths()?;
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(&paths, project_id)?;
    let before = manifest.renders.len();
    manifest
        .renders
        .retain(|render| render.status != "ready" || Path::new(&render.path).is_file());
    if manifest.renders.len() != before {
        write_manifest(&paths, project_id, &manifest)?;
    }
    let mut rows = manifest.renders;
    for render in &mut rows {
        slim_render_for_list(render);
    }
    Ok(rows)
}

fn heal_abandoned_renders(project_id: &str) -> Result<(), String> {
    let paths = default_paths()?;
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let mut manifest = read_manifest(&paths, project_id)?;
    let before = manifest.renders.len();
    manifest
        .renders
        .retain(|render| render.status != "ready" || Path::new(&render.path).is_file());
    let mut healed = false;
    // Hot-reload / crash can leave status=rendering with no worker.
    let now = Utc::now();
    for render in &mut manifest.renders {
        if render.status != "rendering" {
            continue;
        }
        let output = Path::new(&render.path);
        let segments_dir = output.with_extension("segments");
        let partial = output.with_extension("partial.mp4");
        let shaded = output.with_extension("crt-shaded.mp4");
        let crt_partial = output.with_extension("crt-partial.mp4");

        // Final path only exists after a successful concat rename. GPU Look may
        // still be shading while segments remain — only promote when workspace
        // is gone (worker finished cleanup).
        if output.is_file() && !segments_dir.is_dir() && !shaded.is_file() && !crt_partial.is_file()
        {
            render.status = "ready".into();
            if render.finished_at.is_none() {
                render.finished_at = Some(Utc::now().to_rfc3339());
            }
            render.progress = None;
            render.error = None;
            if partial.is_file() {
                let _ = fs::remove_file(&partial);
            }
            healed = true;
            continue;
        }

        // Still have workspace / in-flight CRT files: if nothing has been written
        // recently, the worker is dead (dev reload, crash) — don't leave the UI
        // stuck on a ghost FFmpeg command forever.
        let mut newest = workspace_newest_write_age_secs(&partial, &segments_dir);
        if shaded.is_file() {
            let age = file_mtime_age_secs(&shaded);
            newest = match (newest, age) {
                (Some(n), Some(a)) => Some(n.min(a)),
                (None, a) | (a, None) => a,
            };
        }
        if crt_partial.is_file() {
            let age = file_mtime_age_secs(&crt_partial);
            newest = match (newest, age) {
                (Some(n), Some(a)) => Some(n.min(a)),
                (None, a) | (a, None) => a,
            };
        }
        if output.is_file() {
            let age = file_mtime_age_secs(output);
            newest = match (newest, age) {
                (Some(n), Some(a)) => Some(n.min(a)),
                (None, a) | (a, None) => a,
            };
        }

        let workspace_busy = segments_dir.is_dir()
            || partial.is_file()
            || shaded.is_file()
            || crt_partial.is_file()
            || output.is_file();

        if workspace_busy {
            // Active encodes keep touching files; 90s of silence ⇒ abandoned.
            if newest.map(|age| age >= 90).unwrap_or(true) {
                if output.is_file() {
                    // Concat finished; GPU/worker died — ship the unshaded file.
                    render.status = "ready".into();
                    render.error = None;
                } else {
                    render.status = "failed".into();
                    render.error = Some(
                        "Render was interrupted (encoder stopped updating). Try rendering again."
                            .into(),
                    );
                }
                render.finished_at = Some(Utc::now().to_rfc3339());
                render.progress = None;
                if segments_dir.is_dir() {
                    let _ = fs::remove_dir_all(&segments_dir);
                }
                if partial.is_file() {
                    let _ = fs::remove_file(&partial);
                }
                if shaded.is_file() {
                    let _ = fs::remove_file(&shaded);
                }
                if crt_partial.is_file() {
                    let _ = fs::remove_file(&crt_partial);
                }
                healed = true;
            }
            continue;
        }

        let Ok(created) = chrono::DateTime::parse_from_rfc3339(&render.created_at) else {
            continue;
        };
        if now
            .signed_duration_since(created.with_timezone(&Utc))
            .num_seconds()
            < 180
        {
            continue;
        }
        render.status = "failed".into();
        render.finished_at = Some(Utc::now().to_rfc3339());
        render.progress = None;
        render.error = Some("Render was interrupted before it finished.".into());
        healed = true;
    }
    if manifest.renders.len() != before || healed {
        write_manifest(&paths, project_id, &manifest)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn publisher_render_timeline(
    app: AppHandle,
    project_id: String,
    aspect_ratio: String,
    clips: Vec<RenderTimelineClipInput>,
    looks: Option<RenderLooks>,
) -> Result<TimelineRender, String> {
    let looks = looks.unwrap_or_default();
    let project_for_pending = project_id.clone();
    let aspect_for_pending = aspect_ratio.clone();
    let clips_for_pending = clips.clone();
    let looks_for_pending = looks.clone();
    let pending = tauri::async_runtime::spawn_blocking(move || {
        create_pending_render(
            &project_for_pending,
            &aspect_for_pending,
            &clips_for_pending,
            &looks_for_pending,
        )
    })
    .await
    .map_err(|e| format!("Create pending render failed: {e}"))??;
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
            looks,
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
                            render.finished_at = Some(Utc::now().to_rfc3339());
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
    tauri::async_runtime::spawn_blocking(move || {
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
        let render = manifest.renders.remove(index);
        if Path::new(&render.path).is_file() {
            fs::remove_file(&render.path)
                .map_err(|e| format!("Could not delete render file: {e}"))?;
        }
        // Segment workspace from mid-render (also covers interrupted jobs).
        let segments_dir = Path::new(&render.path).with_extension("segments");
        if segments_dir.is_dir() {
            let _ = fs::remove_dir_all(&segments_dir);
        }
        write_manifest(&paths, &project_id, &manifest)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Delete render task failed: {e}"))?
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

fn default_export_audio_name(project_title: &str, render: &TimelineRender) -> String {
    let project = sanitize_project_name(project_title);
    let stamp = chrono::DateTime::parse_from_rfc3339(&render.created_at)
        .ok()
        .map(|dt| dt.format("%y%m%d_%H%M").to_string())
        .unwrap_or_else(|| "000000_0000".into());
    format!("{project}.{stamp}.mp3")
}

fn pick_export_destination(
    title: &str,
    default_name: &str,
    filter_name: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(mut path) = rfd::FileDialog::new()
        .set_title(title)
        .set_file_name(default_name)
        .add_filter(filter_name, &[extension])
        .save_file()
    else {
        return Ok(None);
    };
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case(extension))
        != Some(true)
    {
        path.set_extension(extension);
    }
    Ok(Some(path))
}

fn ready_render_for_export(
    paths: &ParascenePaths,
    project_id: &str,
    render_id: &str,
) -> Result<TimelineRender, String> {
    let _guard = manifest_lock()
        .lock()
        .map_err(|_| "Render manifest lock was poisoned".to_string())?;
    let manifest = read_manifest(paths, project_id)?;
    let render = manifest
        .renders
        .iter()
        .find(|render| render.id == render_id)
        .cloned()
        .ok_or_else(|| "Render not found".to_string())?;
    if render.status != "ready" {
        return Err("Render is not ready to save".into());
    }
    if !Path::new(&render.path).is_file() {
        return Err("Render file is missing from disk".into());
    }
    Ok(render)
}

#[tauri::command]
pub async fn publisher_export_render(
    project_id: String,
    render_id: String,
    project_title: String,
) -> Result<ExportRenderResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let render = ready_render_for_export(&paths, &project_id, &render_id)?;

        let default_name = default_export_name(&project_title, &render);
        let Some(dest) = pick_export_destination(
            "Save video",
            &default_name,
            "MP4 video",
            "mp4",
        )?
        else {
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

#[tauri::command]
pub async fn publisher_export_render_audio(
    project_id: String,
    render_id: String,
    project_title: String,
) -> Result<ExportRenderResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let render = ready_render_for_export(&paths, &project_id, &render_id)?;

        let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
            "FFmpeg is required to export MP3. Install with: brew install ffmpeg".to_string()
        })?;

        let default_name = default_export_audio_name(&project_title, &render);
        let Some(dest) =
            pick_export_destination("Save MP3", &default_name, "MP3 audio", "mp3")?
        else {
            return Ok(ExportRenderResult {
                cancelled: true,
                path: None,
            });
        };

        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create destination folder: {e}"))?;
        }

        let src = render.path.clone();
        let dest_str = dest
            .to_str()
            .ok_or_else(|| "Invalid destination path".to_string())?
            .to_string();
        let tmp = dest.with_extension("tmp.mp3");
        let tmp_str = tmp
            .to_str()
            .ok_or_else(|| "Invalid temp path".to_string())?
            .to_string();
        let _ = fs::remove_file(&tmp);

        let result = run_ffmpeg(
            &ffmpeg,
            &[
                "-y".into(),
                "-i".into(),
                src,
                "-vn".into(),
                "-c:a".into(),
                "libmp3lame".into(),
                "-b:a".into(),
                "192k".into(),
                tmp_str.clone(),
            ],
        );
        if let Err(err) = result {
            let _ = fs::remove_file(&tmp);
            let lower = err.to_ascii_lowercase();
            if lower.contains("does not contain any stream")
                || lower.contains("output file #0 does not contain any stream")
                || lower.contains("stream map")
            {
                return Err(
                    "This render has no audio track to export as MP3.".into(),
                );
            }
            return Err(format!("Could not export MP3: {err}"));
        }

        let len = tmp.metadata().map(|m| m.len()).unwrap_or(0);
        if len == 0 {
            let _ = fs::remove_file(&tmp);
            return Err("This render has no audio track to export as MP3.".into());
        }
        let _ = fs::remove_file(&dest);
        fs::rename(&tmp, &dest).map_err(|e| format!("Could not finalize MP3: {e}"))?;

        Ok(ExportRenderResult {
            cancelled: false,
            path: Some(dest_str),
        })
    })
    .await
    .map_err(|e| format!("Export audio task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(start_sec: f64, end_sec: f64) -> RenderTimelineClipInput {
        serde_json::from_value(serde_json::json!({
            "assetId": format!("asset-{start_sec}"),
            "startSec": start_sec,
            "endSec": end_sec,
            "lane": "video",
            "kind": "video",
            "inSec": 0.0,
            "outSec": end_sec - start_sec,
        }))
        .expect("clip input")
    }

    fn ranges_for(clips: &[RenderTimelineClipInput], total: f64) -> Vec<VideoRange> {
        let lane: Vec<&RenderTimelineClipInput> = clips.iter().collect();
        video_ranges(&lane, total)
    }

    fn black_count(ranges: &[VideoRange]) -> usize {
        ranges.iter().filter(|r| r.clip_index.is_none()).count()
    }

    #[test]
    fn closes_sub_snap_gap_between_clips() {
        let clips = [clip(0.0, 2.0), clip(2.019, 4.0)];
        let ranges = ranges_for(&clips, 4.0);

        assert_eq!(black_count(&ranges), 0, "{ranges:?}");
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].clip_index, Some(0));
        assert_eq!(ranges[1].clip_index, Some(1));
        // Outgoing clip holds to the incoming clip's snapped start.
        assert_eq!(ranges[0].end, ranges[1].start);
    }

    #[test]
    fn keeps_gap_the_editor_could_place() {
        let clips = [clip(0.0, 2.0), clip(2.5, 4.0)];
        let ranges = ranges_for(&clips, 4.0);

        assert_eq!(black_count(&ranges), 1, "{ranges:?}");
        assert_eq!(ranges[1].clip_index, None);
        assert!((ranges[1].end - ranges[1].start - 0.5).abs() < 1e-9);
    }

    #[test]
    fn keeps_leading_and_trailing_black() {
        let clips = [clip(0.5, 2.0)];
        let ranges = ranges_for(&clips, 3.0);

        assert_eq!(ranges.len(), 3, "{ranges:?}");
        assert_eq!(ranges[0].clip_index, None);
        assert_eq!(ranges[1].clip_index, Some(0));
        assert_eq!(ranges[2].clip_index, None);
    }

    #[test]
    fn drops_gaps_shorter_than_a_frame() {
        // 8ms head gap and a 6ms seam gap: neither survives as a black frame.
        let clips = [clip(0.008, 2.0), clip(2.006, 4.0)];
        let ranges = ranges_for(&clips, 4.0);

        assert_eq!(black_count(&ranges), 0, "{ranges:?}");
        assert_eq!(ranges[0].start, 0.0);
    }

    #[test]
    fn every_cut_lands_on_the_frame_grid_without_holes() {
        let clips = [
            clip(0.0, 2.03),
            clip(2.049, 5.117),
            clip(5.9, 8.44),
            clip(8.44, 10.0),
        ];
        let ranges = ranges_for(&clips, 10.0);

        assert_eq!(ranges[0].start, 0.0);
        for range in &ranges {
            for edge in [range.start, range.end] {
                let frames = edge * RENDER_FPS;
                assert!(
                    (frames - frames.round()).abs() < 1e-9,
                    "{edge} is off the frame grid"
                );
            }
            assert!(range.end > range.start, "{range:?} is empty");
        }
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "hole between {pair:?}");
        }
        // Frame counts sum to the timeline instead of drifting per segment.
        let frames: i64 = ranges
            .iter()
            .map(|r| ((r.end - r.start) * RENDER_FPS).round() as i64)
            .sum();
        assert_eq!(frames, (10.0 * RENDER_FPS) as i64);
    }

    fn linked_audio(partial: serde_json::Value) -> RenderTimelineClipInput {
        let mut base = serde_json::json!({
            "assetId": "asset-v",
            "startSec": 0.0,
            "endSec": 5.0,
            "lane": "audio",
            "kind": "audio",
            "inSec": 0.0,
            "outSec": 2.0,
            "linkedVideoClipId": "v1",
            "reverse": false,
        });
        if let (Some(dst), Some(src)) = (base.as_object_mut(), partial.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(base).expect("linked audio clip")
    }

    fn assert_tiles_cover_clip_without_gaps(
        clip: &RenderTimelineClipInput,
        tiles: &[PlannedAudioTile],
    ) {
        assert!(!tiles.is_empty(), "expected tiles");
        let mut cursor = clip.start_sec;
        for tile in tiles {
            let start = clip.start_sec + tile.local_start;
            let dur = (tile.out_sec - tile.in_sec) / tile.speed.max(0.001);
            let end = start + dur;
            assert!(
                (start - cursor).abs() < 1e-3,
                "gap/overlap before tile local={} (cursor={cursor}, start={start})",
                tile.local_start
            );
            assert!(
                (dur - ((end - start))).abs() < 1e-9,
                "duration mismatch"
            );
            // Media length must match timeline tile at speed.
            let expected_media = dur * tile.speed;
            assert!(
                ((tile.out_sec - tile.in_sec) - expected_media).abs() < 1e-6,
                "media span {} != expected {expected_media}",
                tile.out_sec - tile.in_sec
            );
            cursor = end;
        }
        assert!(
            (cursor - clip.end_sec).abs() < 1e-3,
            "tiles end at {cursor}, clip ends at {}",
            clip.end_sec
        );
    }

    #[test]
    fn linked_loop_partial_last_tile_starts_at_trim_in() {
        // 2.5× playthrough: last tile must be the FIRST 0.5s of the trim, not
        // the second half (the old endpoint-sampling bug).
        let clip = linked_audio(serde_json::json!({
            "startSec": 1.0,
            "endSec": 6.0, // 5s timeline, source span 2s → playthrough 2s
            "inSec": 0.0,
            "outSec": 2.0,
        }));
        let tiles = plan_clip_audio_tiles(&clip);
        assert_eq!(tiles.len(), 3);
        assert!((tiles[0].out_sec - tiles[0].in_sec - 2.0).abs() < 1e-6);
        assert!((tiles[1].out_sec - tiles[1].in_sec - 2.0).abs() < 1e-6);
        assert!((tiles[2].in_sec - 0.0).abs() < 1e-6);
        assert!((tiles[2].out_sec - 1.0).abs() < 1e-6);
        assert!(!tiles.iter().any(|t| t.reverse_trim));
        assert_tiles_cover_clip_without_gaps(&clip, &tiles);
    }

    #[test]
    fn stale_extend_span_past_trim_does_not_leave_silence_holes() {
        // Real project repro (EXAMPLE @ ~17s): in-point was raised after extend
        // froze extendSourceSpanSec at outSec (8.881). Trim is only 6.552s, so
        // tiles spaced by the stale span leave ~inSec of silence between them.
        let clip = linked_audio(serde_json::json!({
            "startSec": 9.0,
            "endSec": 27.1,
            "inSec": 2.328,
            "outSec": 8.881,
            "extendPingPong": true,
            "extendSourceSpanSec": 8.881,
        }));
        let tiles = plan_clip_audio_tiles(&clip);
        assert_tiles_cover_clip_without_gaps(&clip, &tiles);
        // Playthrough must follow the live trim, not the stale frozen span.
        let playthrough = clip_playthrough_unit(&clip);
        assert!(
            (playthrough - (8.881 - 2.328)).abs() < 1e-3,
            "playthrough={playthrough}, expected trim span"
        );
    }

    #[test]
    fn linked_ping_pong_marks_odd_tiles_reversed() {
        let clip = linked_audio(serde_json::json!({
            "startSec": 0.0,
            "endSec": 5.0, // 2 + 2 + 1
            "inSec": 0.0,
            "outSec": 2.0,
            "extendPingPong": true,
        }));
        let tiles = plan_clip_audio_tiles(&clip);
        assert_eq!(tiles.len(), 3);
        assert_eq!(
            tiles.iter().map(|t| t.reverse_trim).collect::<Vec<_>>(),
            vec![false, true, false]
        );
        // Pong tile trims the end of the source then areverse.
        assert!((tiles[1].in_sec - 0.0).abs() < 1e-6);
        assert!((tiles[1].out_sec - 2.0).abs() < 1e-6);
        // Partial forward tile after pong is the start of the trim.
        assert!((tiles[2].in_sec - 0.0).abs() < 1e-6);
        assert!((tiles[2].out_sec - 1.0).abs() < 1e-6);
        assert_tiles_cover_clip_without_gaps(&clip, &tiles);
    }

    #[test]
    fn linked_reverse_still_extends_without_silent_tail() {
        let clip = linked_audio(serde_json::json!({
            "startSec": 0.0,
            "endSec": 5.0,
            "inSec": 0.0,
            "outSec": 2.0,
            "reverse": true,
            "extendPingPong": true,
        }));
        assert!(clip_uses_extended_audio(&clip));
        let tiles = plan_clip_audio_tiles(&clip);
        assert_eq!(tiles.len(), 3);
        assert_tiles_cover_clip_without_gaps(&clip, &tiles);
    }

    #[test]
    fn linked_speed_scales_media_vs_timeline() {
        let clip = linked_audio(serde_json::json!({
            "startSec": 0.0,
            "endSec": 3.0, // playthrough = 2/2 = 1s; timeline 3s → 3 tiles
            "inSec": 0.0,
            "outSec": 2.0,
            "speed": 2.0,
        }));
        let tiles = plan_clip_audio_tiles(&clip);
        assert_eq!(tiles.len(), 3);
        for tile in &tiles {
            assert!((tile.speed - 2.0).abs() < 1e-9);
        }
        assert!((tiles[2].out_sec - tiles[2].in_sec - 2.0).abs() < 1e-6);
        assert_tiles_cover_clip_without_gaps(&clip, &tiles);
    }

    #[test]
    fn many_chops_loop_and_pong_never_leave_timeline_holes() {
        let cases = [
            serde_json::json!({
                "endSec": 7.3, "outSec": 1.7, "extendPingPong": false, "speed": 1.0
            }),
            serde_json::json!({
                "endSec": 9.1, "outSec": 2.4, "extendPingPong": true, "speed": 1.0
            }),
            serde_json::json!({
                "endSec": 6.0, "outSec": 3.0, "extendPingPong": true, "speed": 1.5,
                "reverse": true
            }),
            serde_json::json!({
                "startSec": 3.25, "endSec": 11.8, "inSec": 0.4, "outSec": 2.1,
                "extendPingPong": false, "speed": 0.75
            }),
            serde_json::json!({
                "startSec": 1.0, "endSec": 8.0, "inSec": 0.0, "outSec": 1.0,
                "extendPingPong": true, "extendSourceSpanSec": 1.0, "speed": 1.0
            }),
        ];
        for partial in cases {
            let clip = linked_audio(partial.clone());
            let tiles = plan_clip_audio_tiles(&clip);
            assert_tiles_cover_clip_without_gaps(&clip, &tiles);
        }
    }

    #[test]
    fn punch_bed_removes_priority_span_without_dropping_flanks() {
        let bed = vec![AudioSegment {
            path: PathBuf::from("/tmp/bed.wav"),
            in_sec: 0.0,
            out_sec: 10.0,
            delay_ms: 0,
            reverse_trim: false,
            speed: 1.0,
        }];
        let priority = vec![AudioSegment {
            path: PathBuf::from("/tmp/pri.wav"),
            in_sec: 0.0,
            out_sec: 2.0,
            delay_ms: 3000, // covers timeline 3..5
            reverse_trim: false,
            speed: 1.0,
        }];
        let punched = punch_bed_around_priority(bed, &priority);
        assert_eq!(punched.len(), 2);
        assert_eq!(punched[0].delay_ms, 0);
        assert!((punched[0].out_sec - punched[0].in_sec - 3.0).abs() < 1e-6);
        assert_eq!(punched[1].delay_ms, 5000);
        assert!((punched[1].out_sec - punched[1].in_sec - 5.0).abs() < 1e-6);
    }
}
