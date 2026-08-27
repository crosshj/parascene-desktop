//! Preview-quality timeline fragments for MSE playback.
//!
//! Each fragment is a closed-GOP CMAF media segment for the same init/codec.
//! Timestamps are on the *timeline* (tfdt/PTS continue across files) so
//! SourceBuffer can hold one continuous range. Encode is tiny test quality,
//! not Publisher export.

use super::preview_scheduler::acquire_preview_bake_slot;
use super::catalog::default_paths;
use super::ffmpeg::resolve_ffmpeg;
use super::render::{
    aspect_parts, build_video_segments, concat_demixer_line, fit_inside, run_ffmpeg, safe_id,
    Framing, RenderTimelineClipInput, VideoSegment, VideoSource,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const PREVIEW_LEASE_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
struct PreviewLeaseEntry {
    count: u32,
    expires: Instant,
}

static PREVIEW_LEASES: OnceLock<Mutex<HashMap<String, PreviewLeaseEntry>>> = OnceLock::new();
static PREVIEW_LEASE_PENDING_DELETE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn preview_leases() -> &'static Mutex<HashMap<String, PreviewLeaseEntry>> {
    PREVIEW_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn preview_lease_pending_delete() -> &'static Mutex<HashSet<String>> {
    PREVIEW_LEASE_PENDING_DELETE.get_or_init(|| Mutex::new(HashSet::new()))
}

fn prune_expired_preview_leases(map: &mut HashMap<String, PreviewLeaseEntry>) {
    let now = Instant::now();
    map.retain(|_, entry| entry.count > 0 && entry.expires > now);
}

fn preview_path_key(path: &str) -> String {
    path.trim().to_string()
}

fn preview_path_leased(path: &Path) -> bool {
    let key = preview_path_key(&path.display().to_string());
    if key.is_empty() {
        return false;
    }
    let mut guard = preview_leases()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_expired_preview_leases(&mut guard);
    guard
        .get(&key)
        .map(|entry| entry.count > 0 && entry.expires > Instant::now())
        .unwrap_or(false)
}

fn preview_lease_adjust(paths: &[String], delta: i32) -> Result<(), String> {
    if delta == 0 {
        return Ok(());
    }
    let mut guard = preview_leases()
        .lock()
        .map_err(|_| "Preview lease registry unavailable".to_string())?;
    prune_expired_preview_leases(&mut guard);
    let now = Instant::now();
    for raw in paths {
        let key = preview_path_key(raw);
        if key.is_empty() {
            continue;
        }
        if delta > 0 {
            let entry = guard.entry(key).or_insert(PreviewLeaseEntry {
                count: 0,
                expires: now + PREVIEW_LEASE_TTL,
            });
            entry.count = entry.count.saturating_add(delta as u32);
            entry.expires = now + PREVIEW_LEASE_TTL;
        } else {
            let Some(entry) = guard.get_mut(&key) else {
                continue;
            };
            entry.count = entry.count.saturating_sub((-delta) as u32);
            if entry.count == 0 {
                guard.remove(&key);
                drop(guard);
                preview_try_delete_pending(&key);
                guard = preview_leases()
                    .lock()
                    .map_err(|_| "Preview lease registry unavailable".to_string())?;
            }
        }
    }
    Ok(())
}

fn preview_mark_pending_delete(path: &Path) {
    let key = preview_path_key(&path.display().to_string());
    if key.is_empty() {
        return;
    }
    let Ok(mut pending) = preview_lease_pending_delete().lock() else {
        return;
    };
    pending.insert(key);
}

fn preview_try_delete_pending(path_key: &str) {
    let should_delete = {
        let Ok(mut pending) = preview_lease_pending_delete().lock() else {
            return;
        };
        if !pending.contains(path_key) {
            return;
        }
        if preview_path_leased(Path::new(path_key)) {
            return;
        }
        pending.remove(path_key);
        true
    };
    if should_delete {
        let _ = fs::remove_file(path_key);
    }
}

fn clear_preview_dir_respecting_leases(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }
    let manifest = manifest_path(dir);
    if manifest.is_file() && !preview_path_leased(&manifest) {
        let _ = fs::remove_file(&manifest);
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if preview_path_leased(&path) {
            preview_mark_pending_delete(&path);
            continue;
        }
        let _ = fs::remove_file(&path);
    }
    if fs::read_dir(dir)
        .map(|mut iter| iter.next().is_none())
        .unwrap_or(false)
    {
        let _ = fs::remove_dir(dir);
    }
    Ok(())
}

const PREVIEW_PRESET: &str = "ultrafast";
/// Must match the tag mixed into FE fragment fingerprints until plan moves fully to Rust.
pub const PREVIEW_ENCODE_TAG: &str = "pv-cmaf6";
const MANIFEST_FILE: &str = "manifest.json";

/// Encode parameters per preview-quality setting: resolution, bitrate, and the
/// output frame clock. Cut snapping still uses the 30fps export grid in
/// `build_video_segments` regardless of the preview fps. `scale` multiplies
/// the low-quality output sizes. Fps values must divide the 2s fragment into
/// whole frames (10/15/30 all do).
#[derive(Clone, Copy, Debug)]
struct PreviewQualityParams {
    /// Landscape pad stage before the aspect crop. Keep even.
    stage_w: u32,
    stage_h: u32,
    crf: &'static str,
    maxrate: &'static str,
    bufsize: &'static str,
    scale: u32,
    fps: f64,
}

fn preview_quality_params(quality: &str) -> PreviewQualityParams {
    match quality.trim() {
        "high" => PreviewQualityParams {
            stage_w: 960,
            stage_h: 540,
            crf: "28",
            maxrate: "2500k",
            bufsize: "5000k",
            scale: 3,
            fps: 30.0,
        },
        "medium" => PreviewQualityParams {
            stage_w: 640,
            stage_h: 360,
            crf: "33",
            maxrate: "700k",
            bufsize: "1400k",
            scale: 2,
            fps: 15.0,
        },
        _ => PreviewQualityParams {
            stage_w: 320,
            stage_h: 180,
            crf: "40",
            maxrate: "80k",
            bufsize: "160k",
            scale: 1,
            fps: 10.0,
        },
    }
}

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewSnapshot {
    pub encode_tag: String,
    pub aspect_ratio: String,
    pub quality: String,
    pub fragments: Vec<TimelinePreviewSnapshotFragment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewSnapshotFragment {
    pub index: u32,
    pub start_sec: f64,
    pub duration_sec: f64,
    pub fingerprint: String,
    pub path: String,
}

fn empty_snapshot(aspect_ratio: &str, quality: &str) -> TimelinePreviewSnapshot {
    TimelinePreviewSnapshot {
        encode_tag: PREVIEW_ENCODE_TAG.to_string(),
        aspect_ratio: aspect_ratio.to_string(),
        quality: quality.to_string(),
        fragments: Vec::new(),
    }
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_FILE)
}

fn read_snapshot(dir: &Path) -> Option<TimelinePreviewSnapshot> {
    let raw = fs::read_to_string(manifest_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_snapshot(dir: &Path, snapshot: &TimelinePreviewSnapshot) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create preview manifest dir: {e}"))?;
    let partial = dir.join("manifest.partial.json");
    let body = serde_json::to_string_pretty(snapshot)
        .map_err(|e| format!("Could not serialize preview manifest: {e}"))?;
    fs::write(&partial, &body).map_err(|e| format!("Could not write preview manifest: {e}"))?;
    fs::rename(&partial, manifest_path(dir))
        .map_err(|e| format!("Could not finalize preview manifest: {e}"))?;
    Ok(())
}

fn upsert_snapshot_fragment(
    dir: &Path,
    aspect_ratio: &str,
    quality: &str,
    baked: &TimelineFragmentBakeResult,
) -> Result<(), String> {
    let mut snapshot = read_snapshot(dir).unwrap_or_else(|| empty_snapshot(aspect_ratio, quality));
    if snapshot.encode_tag != PREVIEW_ENCODE_TAG
        || snapshot.aspect_ratio != aspect_ratio
        || snapshot.quality != quality
    {
        snapshot = empty_snapshot(aspect_ratio, quality);
    }
    snapshot.fragments.retain(|frag| frag.index != baked.index);
    snapshot.fragments.push(TimelinePreviewSnapshotFragment {
        index: baked.index,
        start_sec: baked.start_sec,
        duration_sec: baked.duration_sec,
        fingerprint: baked.fingerprint.clone(),
        path: baked.path.clone(),
    });
    snapshot.fragments.sort_by_key(|frag| frag.index);
    write_snapshot(dir, &snapshot)
}

fn snapshot_from_disk(dir: &Path) -> TimelinePreviewSnapshot {
    let mut snapshot = read_snapshot(dir).unwrap_or_else(|| empty_snapshot("", ""));
    let quality = snapshot.quality.clone();
    snapshot.fragments.retain(|frag| {
        fragment_artifact_matches_plan(
            Path::new(&frag.path),
            Some(frag.start_sec),
            Some(frag.duration_sec),
            Some(if quality.is_empty() { "low" } else { &quality }),
        )
    });
    snapshot
}

fn preview_dir(paths: &super::paths::ParascenePaths, project_id: &str) -> PathBuf {
    paths
        .cache
        .join("timeline-preview")
        .join(safe_id(project_id))
}

fn preview_output_size(aspect_ratio: &str, params: PreviewQualityParams) -> (u32, u32) {
    let (w, h) = match aspect_ratio.trim() {
        "1:1" => (180, 180),
        "9:16" => (180, 320),
        "4:5" => (180, 224),
        _ => (320, 180),
    };
    (w * params.scale, h * params.scale)
}

fn preview_frame_filter(
    out_w: u32,
    out_h: u32,
    crop_w: u32,
    crop_h: u32,
    framing: Framing,
    zoom: f64,
    center_x: f64,
    center_y: f64,
    params: PreviewQualityParams,
) -> String {
    let prefix = "setsar=1";
    let tail = format!("fps={:.0},format=yuv420p", params.fps);
    let stage_w = params.stage_w;
    let stage_h = params.stage_h;
    let zoom = zoom.clamp(1.0, 4.0);
    let dx_stage = center_x.clamp(-50.0, 50.0) / 100.0 * stage_w as f64;
    let dy_stage = center_y.clamp(-50.0, 50.0) / 100.0 * stage_h as f64;
    let dx_out = center_x.clamp(-50.0, 50.0) / 100.0 * out_w as f64;
    let dy_out = center_y.clamp(-50.0, 50.0) / 100.0 * out_h as f64;
    let identity = (zoom - 1.0).abs() < 1e-6 && dx_out.abs() < 1e-6 && dy_out.abs() < 1e-6;
    match framing {
        Framing::Fit => {
            let base = format!(
                "{prefix},scale={stage_w}:{stage_h}:force_original_aspect_ratio=decrease,pad={stage_w}:{stage_h}:(ow-iw)/2:(oh-ih)/2:black"
            );
            let zoomed = if identity {
                base
            } else {
                format!(
                    "{base},scale=iw*{zoom:.6}:ih*{zoom:.6},pad=iw+{stage_w}:ih+{stage_h}:{stage_w}/2:{stage_h}/2:black,crop={stage_w}:{stage_h}:(iw-{stage_w})/2-{dx_stage:.3}:(ih-{stage_h})/2-{dy_stage:.3}"
                )
            };
            format!(
                "{zoomed},crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,scale={out_w}:{out_h},setsar=1,{tail}"
            )
        }
        Framing::Fill => {
            let base = format!(
                "{prefix},scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h}"
            );
            let zoomed = if identity {
                base
            } else {
                format!(
                    "{base},scale=iw*{zoom:.6}:ih*{zoom:.6},pad=iw+{out_w}:ih+{out_h}:{out_w}/2:{out_h}/2:black,crop={out_w}:{out_h}:(iw-{out_w})/2-{dx_out:.3}:(ih-{out_h})/2-{dy_out:.3}"
                )
            };
            format!("{zoomed},setsar=1,{tail}")
        }
        Framing::Stretch => {
            let base = format!("{prefix},scale={out_w}:{out_h}");
            let zoomed = if identity {
                base
            } else {
                format!(
                    "{base},scale=iw*{zoom:.6}:ih*{zoom:.6},pad=iw+{out_w}:ih+{out_h}:{out_w}/2:{out_h}/2:black,crop={out_w}:{out_h}:(iw-{out_w})/2-{dx_out:.3}:(ih-{out_h})/2-{dy_out:.3}"
                )
            };
            format!("{zoomed},setsar=1,{tail}")
        }
    }
}

fn push_preview_x264(args: &mut Vec<String>, gop_frames: u32, params: PreviewQualityParams) {
    let gop = gop_frames.max(1).to_string();
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push(PREVIEW_PRESET.into());
    args.push("-crf".into());
    args.push(params.crf.into());
    args.push("-maxrate".into());
    args.push(params.maxrate.into());
    args.push("-bufsize".into());
    args.push(params.bufsize.into());
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
    args.push("10000".into());
}

/// Timescale written by `-video_track_timescale`; tfdt patching must match.
const PREVIEW_TIMESCALE: u64 = 10000;

fn push_preview_cmaf_flags(args: &mut Vec<String>) {
    args.push("-movflags".into());
    args.push("+empty_moov+default_base_moof+frag_keyframe+omit_tfhd_offset".into());
}

/// Put the fragment on the timeline by adding `offset_ticks` to every tfdt.
///
/// ffmpeg's mov muxer normalizes each file to start at t=0 no matter what
/// (setpts and -output_ts_offset are both discarded), so we do what packagers
/// do: rewrite baseMediaDecodeTime after encode. Tick-exact, no float drift.
fn patch_tfdt_offset(bytes: &mut [u8], offset_ticks: u64) -> Result<u32, String> {
    fn read_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    fn patch_traf(traf: &mut [u8], offset_ticks: u64, patched: &mut u32) -> Result<(), String> {
        let mut i = 0usize;
        while i + 8 <= traf.len() {
            let size = read_u32(traf, i) as usize;
            if size < 8 || i + size > traf.len() {
                break;
            }
            if &traf[i + 4..i + 8] == b"tfdt" {
                let body = i + 8;
                if body >= traf.len() {
                    return Err("Truncated tfdt box".into());
                }
                let version = traf[body];
                if version == 1 {
                    if body + 12 > traf.len() {
                        return Err("Truncated tfdt v1 box".into());
                    }
                    let mut raw = [0u8; 8];
                    raw.copy_from_slice(&traf[body + 4..body + 12]);
                    let value = u64::from_be_bytes(raw).saturating_add(offset_ticks);
                    traf[body + 4..body + 12].copy_from_slice(&value.to_be_bytes());
                } else {
                    if body + 8 > traf.len() {
                        return Err("Truncated tfdt v0 box".into());
                    }
                    let value = u64::from(read_u32(traf, body + 4)) + offset_ticks;
                    let value: u32 = value
                        .try_into()
                        .map_err(|_| "tfdt overflow: fragment start too large for v0".to_string())?;
                    traf[body + 4..body + 8].copy_from_slice(&value.to_be_bytes());
                }
                *patched += 1;
            }
            i += size;
        }
        Ok(())
    }

    let mut patched = 0u32;
    let mut i = 0usize;
    while i + 8 <= bytes.len() {
        let size = read_u32(bytes, i) as usize;
        if size < 8 || i + size > bytes.len() {
            break;
        }
        if &bytes[i + 4..i + 8] == b"moof" {
            let (start, end) = (i + 8, i + size);
            let mut j = start;
            while j + 8 <= end {
                let child_size = read_u32(bytes, j) as usize;
                if child_size < 8 || j + child_size > end {
                    break;
                }
                if &bytes[j + 4..j + 8] == b"traf" {
                    patch_traf(&mut bytes[j + 8..j + child_size], offset_ticks, &mut patched)?;
                }
                j += child_size;
            }
        }
        i += size;
    }
    Ok(patched)
}

fn patch_fragment_timeline_offset(path: &Path, start_sec: f64) -> Result<(), String> {
    let offset_ticks = (start_sec * PREVIEW_TIMESCALE as f64).round() as u64;
    if offset_ticks == 0 {
        return Ok(());
    }
    let mut bytes =
        fs::read(path).map_err(|e| format!("Could not read fragment for tfdt patch: {e}"))?;
    let patched = patch_tfdt_offset(&mut bytes, offset_ticks)?;
    if patched == 0 {
        return Err("Fragment has no tfdt box to place on the timeline".into());
    }
    fs::write(path, bytes).map_err(|e| format!("Could not write patched fragment: {e}"))
}

fn fragment_frame_count(duration_sec: f64, fps: f64) -> u32 {
    (duration_sec * fps).round().max(1.0) as u32
}

fn push_segment_input(
    args: &mut Vec<String>,
    segment: &VideoSegment,
    width: u32,
    height: u32,
    fps: f64,
) {
    if let Some(source) = &segment.source {
        if source.is_image {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-framerate".into());
            args.push(format!("{fps:.0}"));
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
        "color=c=black:s={width}x{height}:d={:.3}:rate={fps:.0}",
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
    params: PreviewQualityParams,
) -> String {
    if let Some(source) = source {
        let frame = preview_frame_filter(
            width,
            height,
            crop_w,
            crop_h,
            source.framing,
            source.zoom,
            source.center_x,
            source.center_y,
            params,
        );
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
    format!("setsar=1,fps={:.0},format=yuv420p", params.fps)
}

fn fragment_filter_complex(
    segments: &[VideoSegment],
    width: u32,
    height: u32,
    crop_w: u32,
    crop_h: u32,
    params: PreviewQualityParams,
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
            params,
        );
        parts.push(format!("[{idx}:v]{chain}[v{idx}]"));
    }
    if segments.len() == 1 {
        parts.push("[v0]setpts=PTS-STARTPTS[vout]".into());
    } else {
        let labels: String = (0..segments.len()).map(|i| format!("[v{i}]")).collect();
        parts.push(format!(
            "{labels}concat=n={}:v=1:a=0,setpts=PTS-STARTPTS[vout]",
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
    start_sec: f64,
    duration_sec: f64,
    params: PreviewQualityParams,
    dest: &Path,
) -> Result<(), String> {
    let frames = fragment_frame_count(duration_sec, params.fps);
    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-nostdin".into()];
    for segment in segments {
        push_segment_input(&mut args, segment, width, height, params.fps);
    }
    args.push("-filter_complex".into());
    args.push(fragment_filter_complex(
        segments, width, height, crop_w, crop_h, params,
    ));
    args.push("-map".into());
    args.push("[vout]".into());
    args.push("-an".into());
    args.push("-r".into());
    args.push(format!("{:.0}", params.fps));
    args.push("-fps_mode".into());
    args.push("cfr".into());
    push_preview_x264(&mut args, frames, params);
    push_preview_cmaf_flags(&mut args);
    args.push("-frames:v".into());
    args.push(frames.to_string());
    args.push(dest.display().to_string());
    run_ffmpeg(ffmpeg, &args)?;
    patch_fragment_timeline_offset(dest, start_sec)
}

/// Encode one independently invalidatable preview fragment for `[start, start+dur)`.
/// Not a slice of a full-timeline render — only overlapping clips are used.
fn encode_preview_fragment(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    project_id: &str,
    clips: &[RenderTimelineClipInput],
    aspect_ratio: &str,
    quality: &str,
    start_sec: f64,
    duration_sec: f64,
    dest: &Path,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to bake timeline preview. Install with: brew install ffmpeg".to_string()
    })?;
    let params = preview_quality_params(quality);
    let (width, height) = preview_output_size(aspect_ratio, params);
    let (aw, ah) = aspect_parts(aspect_ratio);
    let (crop_w, crop_h) = fit_inside(params.stage_w, params.stage_h, aw, ah);
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
        start_sec,
        duration_sec,
        params,
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
            if preview_path_leased(&path) {
                preview_mark_pending_delete(&path);
                continue;
            }
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

fn fragment_partial_path(dir: &Path, index: u32, fingerprint: &str) -> PathBuf {
    dir.join(format!("frag_{index:04}_{fingerprint}.partial.mp4"))
}

fn read_u32_be(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4)
        .and_then(|slice| slice.try_into().ok())
        .map(u32::from_be_bytes)
}

fn read_first_tfdt_decode_ticks(data: &[u8]) -> Option<u64> {
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = read_u32_be(data, i)? as usize;
        if size < 8 || i + size > data.len() {
            break;
        }
        let kind = &data[i + 4..i + 8];
        if kind == b"moof" || kind == b"traf" {
            if let Some(value) = read_first_tfdt_decode_ticks(&data[i + 8..i + size]) {
                return Some(value);
            }
        } else if kind == b"tfdt" {
            let body = i + 8;
            if body >= data.len() {
                return None;
            }
            let version = data[body];
            if version == 1 {
                if body + 12 > data.len() {
                    return None;
                }
                let raw: [u8; 8] = data[body + 4..body + 12].try_into().ok()?;
                return Some(u64::from_be_bytes(raw));
            }
            if body + 8 > data.len() {
                return None;
            }
            return Some(u64::from(read_u32_be(data, body + 4)?));
        }
        i += size;
    }
    None
}

fn read_trun_sample_count(data: &[u8]) -> Option<u32> {
    let mut i = 0usize;
    while i + 8 <= data.len() {
        let size = read_u32_be(data, i)? as usize;
        if size < 8 || i + size > data.len() {
            break;
        }
        let kind = &data[i + 4..i + 8];
        if kind == b"moof" || kind == b"traf" {
            if let Some(value) = read_trun_sample_count(&data[i + 8..i + size]) {
                return Some(value);
            }
        } else if kind == b"trun" {
            let body = i + 8;
            if body + 8 > data.len() {
                return None;
            }
            return read_u32_be(data, body + 4);
        }
        i += size;
    }
    None
}

/// Structural + sample-clock validation when plan fields are known.
fn fragment_artifact_matches_plan(
    path: &Path,
    start_sec: Option<f64>,
    duration_sec: Option<f64>,
    quality: Option<&str>,
) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if meta.len() < 256 {
        return false;
    }
    let Ok(data) = fs::read(path) else {
        return false;
    };
    if data.len() < 12 {
        return false;
    }
    if &data[4..8] != b"ftyp" {
        return false;
    }
    if !data.windows(4).any(|window| window == b"moof") {
        return false;
    }
    let (Some(start_sec), Some(duration_sec)) = (start_sec, duration_sec) else {
        return true;
    };
    let quality = quality.unwrap_or("low");
    let params = preview_quality_params(quality);
    let expected_ticks = (start_sec * PREVIEW_TIMESCALE as f64).round() as i64;
    let Some(actual_ticks) = read_first_tfdt_decode_ticks(&data) else {
        return false;
    };
    if (actual_ticks as i64 - expected_ticks).abs() > 1 {
        return false;
    }
    let expected_frames = fragment_frame_count(duration_sec, params.fps);
    let Some(actual_frames) = read_trun_sample_count(&data) else {
        return false;
    };
    actual_frames.abs_diff(expected_frames) <= 1
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePreviewConfig {
    pub encode_tag: String,
    pub fragment_duration_sec: f64,
    pub fragment_fps: f64,
    pub timescale: u64,
}

pub fn timeline_preview_config() -> TimelinePreviewConfig {
    TimelinePreviewConfig {
        encode_tag: PREVIEW_ENCODE_TAG.to_string(),
        fragment_duration_sec: 2.0,
        fragment_fps: 30.0,
        timescale: PREVIEW_TIMESCALE,
    }
}

#[tauri::command]
pub async fn library_read_timeline_preview_config() -> Result<TimelinePreviewConfig, String> {
    Ok(timeline_preview_config())
}

#[tauri::command]
pub async fn library_bake_timeline_fragment(
    app: AppHandle,
    project_id: String,
    clips: Vec<RenderTimelineClipInput>,
    aspect_ratio: String,
    quality: Option<String>,
    index: u32,
    start_sec: f64,
    duration_sec: f64,
    fingerprint: String,
) -> Result<TimelineFragmentBakeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bake_guard = acquire_preview_bake_slot(&project_id, index, &fingerprint)?;
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
        let quality_str = quality.as_deref().unwrap_or("low").to_string();
        let finish = |dest: PathBuf| -> Result<TimelineFragmentBakeResult, String> {
            if bake_guard.is_stale() {
                return Err("Stale preview bake".into());
            }
            let result = TimelineFragmentBakeResult {
                path: dest.display().to_string(),
                index,
                start_sec,
                duration_sec,
                fingerprint: fingerprint.clone(),
            };
            if let Err(err) = upsert_snapshot_fragment(&dir, &aspect_ratio, &quality_str, &result)
            {
                eprintln!("[preview] manifest upsert failed: {err}");
            }
            Ok(result)
        };
        let dest = dir.join(format!("frag_{index:04}_{fingerprint}.mp4"));
        if dest.is_file() {
            if fragment_artifact_matches_plan(
                &dest,
                Some(start_sec),
                Some(duration_sec),
                Some(quality.as_deref().unwrap_or("low")),
            ) {
                return finish(dest);
            }
            let _ = fs::remove_file(&dest);
        }
        if bake_guard.is_stale() {
            return Err("Stale preview bake".into());
        }
        let partial = fragment_partial_path(&dir, index, &fingerprint);
        if partial.exists() {
            let _ = fs::remove_file(&partial);
        }
        encode_preview_fragment(
            &app,
            &paths,
            &project_id,
            &clips,
            &aspect_ratio,
            quality.as_deref().unwrap_or("low"),
            start_sec,
            duration_sec,
            &partial,
        )?;
        if bake_guard.is_stale() {
            let _ = fs::remove_file(&partial);
            return Err("Stale preview bake".into());
        }
        if !partial.is_file() {
            return Err("ffmpeg preview fragment produced no output".into());
        }
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }
        fs::rename(&partial, &dest)
            .map_err(|e| format!("Could not finalize preview fragment: {e}"))?;
        prune_index_files(&dir, index, &dest);
        if !fragment_artifact_matches_plan(
            &dest,
            Some(start_sec),
            Some(duration_sec),
            Some(quality.as_deref().unwrap_or("low")),
        ) {
            let _ = fs::remove_file(&dest);
            return Err("Preview fragment failed timeline timestamp check".into());
        }
        finish(dest)
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
pub async fn library_read_timeline_preview_snapshot(
    project_id: String,
) -> Result<TimelinePreviewSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let dir = preview_dir(&paths, &project_id);
        if !dir.is_dir() {
            return Ok(empty_snapshot("", ""));
        }
        Ok(snapshot_from_disk(&dir))
    })
    .await
    .map_err(|e| format!("Read timeline preview snapshot failed: {e}"))?
}

#[tauri::command]
pub async fn library_preview_lease_acquire(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || preview_lease_adjust(&paths, 1))
        .await
        .map_err(|e| format!("Preview lease acquire failed: {e}"))?
}

#[tauri::command]
pub async fn library_preview_lease_release(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || preview_lease_adjust(&paths, -1))
        .await
        .map_err(|e| format!("Preview lease release failed: {e}"))?
}

#[tauri::command]
pub async fn library_clear_timeline_fragments(project_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = default_paths()?;
        let dir = preview_dir(&paths, &project_id);
        clear_preview_dir_respecting_leases(&dir)
    })
    .await
    .map_err(|e| format!("Clear timeline preview cache failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_sizes_stay_even_and_scale_with_quality() {
        let low = preview_quality_params("low");
        assert_eq!(preview_output_size("16:9", low), (320, 180));
        assert_eq!(preview_output_size("9:16", low), (180, 320));
        assert_eq!(preview_output_size("1:1", low), (180, 180));
        let medium = preview_quality_params("medium");
        assert_eq!(preview_output_size("16:9", medium), (640, 360));
        let high = preview_quality_params("high");
        assert_eq!(preview_output_size("16:9", high), (960, 540));
        for params in [low, medium, high] {
            let (w, h) = preview_output_size("4:5", params);
            assert_eq!(w % 2, 0);
            assert_eq!(h % 2, 0);
        }
    }

    #[test]
    fn preview_frame_filter_bakes_image_zoom_and_pan() {
        let params = preview_quality_params("medium");
        let plain = preview_frame_filter(
            640,
            360,
            640,
            360,
            Framing::Fit,
            1.0,
            0.0,
            0.0,
            params,
        );
        assert!(!plain.contains("scale=iw*"));
        let zoomed = preview_frame_filter(
            640,
            360,
            640,
            360,
            Framing::Fit,
            2.0,
            25.0,
            -10.0,
            params,
        );
        assert!(zoomed.contains("scale=iw*2.000000:ih*2.000000"));
        assert!(zoomed.contains(&format!(
            "crop={}:{}:(iw-{})/2-{:.3}",
            params.stage_w,
            params.stage_h,
            params.stage_w,
            25.0 / 100.0 * params.stage_w as f64
        )));
    }

    #[test]
    fn preview_quality_changes_bitrate_resolution_and_fps() {
        let low = preview_quality_params("low");
        let medium = preview_quality_params("medium");
        let high = preview_quality_params("high");
        assert_ne!(low.crf, high.crf);
        assert_ne!(low.maxrate, high.maxrate);
        assert_ne!((low.stage_w, low.stage_h), (high.stage_w, high.stage_h));
        assert_eq!(low.fps, 10.0);
        assert_eq!(medium.fps, 15.0);
        assert_eq!(high.fps, 30.0);
        // Unknown values fall back to low.
        assert_eq!(preview_quality_params("??").stage_w, low.stage_w);
    }

    #[test]
    fn preview_fps_follows_quality_and_divides_fragments_evenly() {
        assert_eq!(fragment_frame_count(2.0, preview_quality_params("low").fps), 20);
        assert_eq!(
            fragment_frame_count(2.0, preview_quality_params("medium").fps),
            30
        );
        assert_eq!(
            fragment_frame_count(2.0, preview_quality_params("high").fps),
            60
        );
        assert_eq!(fragment_frame_count(1.5, 10.0), 15);
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
        let graph =
            fragment_filter_complex(&segments, 320, 180, 320, 180, preview_quality_params("low"));
        assert!(graph.contains("[0:v]"));
        assert!(graph.contains("fps=10"));
        assert!(graph.contains("[1:v]"));
        assert!(graph.contains("concat=n=2:v=1:a=0"));
        assert!(graph.contains("setpts=PTS-STARTPTS[vout]"));
        assert!(!graph.contains("concat=n=2:v=1:a=0[vout]"));
    }

    fn tfdt_v0_fixture(base_time: u32) -> Vec<u8> {
        // moof > traf > tfdt(v0), minimal but structurally valid.
        let mut tfdt = Vec::new();
        tfdt.extend_from_slice(&16u32.to_be_bytes());
        tfdt.extend_from_slice(b"tfdt");
        tfdt.extend_from_slice(&[0, 0, 0, 0]);
        tfdt.extend_from_slice(&base_time.to_be_bytes());
        let mut traf = Vec::new();
        traf.extend_from_slice(&((8 + tfdt.len()) as u32).to_be_bytes());
        traf.extend_from_slice(b"traf");
        traf.extend_from_slice(&tfdt);
        let mut moof = Vec::new();
        moof.extend_from_slice(&((8 + traf.len()) as u32).to_be_bytes());
        moof.extend_from_slice(b"moof");
        moof.extend_from_slice(&traf);
        moof
    }

    #[test]
    fn tfdt_patch_places_fragment_on_the_timeline() {
        let mut bytes = tfdt_v0_fixture(0);
        let patched = patch_tfdt_offset(&mut bytes, 40000).expect("patch");
        assert_eq!(patched, 1);
        // moof hdr (8) + traf hdr (8) + tfdt size/type/verflags (12) = 28
        let value = u32::from_be_bytes(bytes[28..32].try_into().unwrap());
        assert_eq!(value, 40000); // 4.0s at timescale 10000
    }

    #[test]
    fn tfdt_patch_adds_to_existing_base_time() {
        let mut bytes = tfdt_v0_fixture(5000);
        patch_tfdt_offset(&mut bytes, 20000).expect("patch");
        let value = u32::from_be_bytes(bytes[28..32].try_into().unwrap());
        assert_eq!(value, 25000);
    }

    #[test]
    fn tfdt_patch_errors_when_no_tfdt_present() {
        let mut bytes = vec![0u8; 16];
        bytes[..4].copy_from_slice(&16u32.to_be_bytes());
        bytes[4..8].copy_from_slice(b"free");
        let patched = patch_tfdt_offset(&mut bytes, 40000).expect("patch");
        assert_eq!(patched, 0);
    }

    fn trun_v0_fixture(sample_count: u32) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&[0u8; 4]);
        body.extend_from_slice(&sample_count.to_be_bytes());
        let mut trun = Vec::new();
        trun.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
        trun.extend_from_slice(b"trun");
        trun.extend_from_slice(&body);
        trun
    }

    fn ftyp_box() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&20u32.to_be_bytes());
        v.extend_from_slice(b"ftyp");
        v.extend_from_slice(b"isom");
        v.extend_from_slice(&512u32.to_be_bytes());
        v.extend_from_slice(b"isom");
        v
    }

    fn pad_fragment_bytes(mut data: Vec<u8>) -> Vec<u8> {
        if data.len() < 256 {
            data.resize(256, 0);
        }
        data
    }

    fn valid_preview_fragment_bytes(start_sec: f64, duration_sec: f64, quality: &str) -> Vec<u8> {
        let params = preview_quality_params(quality);
        let ticks = (start_sec * PREVIEW_TIMESCALE as f64).round() as u32;
        let frames = fragment_frame_count(duration_sec, params.fps);
        let tfdt = {
            let mut inner = Vec::new();
            inner.extend_from_slice(&16u32.to_be_bytes());
            inner.extend_from_slice(b"tfdt");
            inner.extend_from_slice(&[0, 0, 0, 0]);
            inner.extend_from_slice(&ticks.to_be_bytes());
            inner
        };
        let trun = trun_v0_fixture(frames);
        let mut traf = Vec::new();
        traf.extend_from_slice(&((8 + tfdt.len() + trun.len()) as u32).to_be_bytes());
        traf.extend_from_slice(b"traf");
        traf.extend_from_slice(&tfdt);
        traf.extend_from_slice(&trun);
        let mut moof = Vec::new();
        moof.extend_from_slice(&((8 + traf.len()) as u32).to_be_bytes());
        moof.extend_from_slice(b"moof");
        moof.extend_from_slice(&traf);
        let mut data = ftyp_box();
        data.extend(moof);
        pad_fragment_bytes(data)
    }

    fn minimal_fragment_bytes() -> Vec<u8> {
        valid_preview_fragment_bytes(0.0, 2.0, "low")
    }

    #[test]
    fn fragment_artifact_matches_plan_checks_tfdt_and_sample_count() {
        let dir = std::env::temp_dir().join(format!(
            "parascene-preview-plan-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("frag.mp4");
        fs::write(&path, valid_preview_fragment_bytes(0.0, 2.0, "low")).unwrap();
        assert!(fragment_artifact_matches_plan(&path, Some(0.0), Some(2.0), Some("low")));
        assert!(!fragment_artifact_matches_plan(&path, Some(2.0), Some(2.0), Some("low")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fragment_artifact_valid_requires_ftyp_moof_and_min_size() {
        let dir = std::env::temp_dir().join(format!(
            "parascene-preview-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("frag.mp4");

        fs::write(&path, b"tiny").unwrap();
        assert!(!fragment_artifact_matches_plan(&path, None, None, None));

        let mut ftyp_only = vec![0u8; 300];
        ftyp_only[4..8].copy_from_slice(b"ftyp");
        fs::write(&path, &ftyp_only).unwrap();
        assert!(!fragment_artifact_matches_plan(&path, None, None, None));

        fs::write(&path, minimal_fragment_bytes()).unwrap();
        assert!(fragment_artifact_matches_plan(&path, None, None, None));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_prune_skips_leased_fragment_files() {
        let dir = std::env::temp_dir().join(format!(
            "parascene-preview-lease-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let keep = dir.join("frag_0000_keep1234.mp4");
        let stale = dir.join("frag_0000_stale5678.mp4");
        fs::write(&keep, minimal_fragment_bytes()).unwrap();
        fs::write(&stale, minimal_fragment_bytes()).unwrap();

        preview_lease_adjust(&[stale.display().to_string()], 1).expect("lease");
        prune_index_files(&dir, 0, &keep);
        assert!(stale.is_file(), "leased stale fragment must survive prune");
        assert!(keep.is_file(), "canonical fragment must remain");

        preview_lease_adjust(&[stale.display().to_string()], -1).expect("release");
        assert!(
            !stale.is_file(),
            "stale fragment should delete after lease release when pending"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_snapshot_roundtrip_and_prunes_missing_files() {
        let dir = std::env::temp_dir().join(format!(
            "parascene-preview-manifest-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let frag_path = dir.join("frag_0000_test1234.mp4");
        fs::write(&frag_path, minimal_fragment_bytes()).unwrap();

        let baked = TimelineFragmentBakeResult {
            path: frag_path.display().to_string(),
            index: 0,
            start_sec: 0.0,
            duration_sec: 2.0,
            fingerprint: "test1234".into(),
        };
        upsert_snapshot_fragment(&dir, "16:9", "low", &baked).expect("upsert");

        let snapshot = read_snapshot(&dir).expect("read");
        assert_eq!(snapshot.encode_tag, PREVIEW_ENCODE_TAG);
        assert_eq!(snapshot.fragments.len(), 1);

        fs::remove_file(&frag_path).unwrap();
        let pruned = snapshot_from_disk(&dir);
        assert!(pruned.fragments.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
