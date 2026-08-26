//! Join Studio: FFmpeg export-true seam preview + optional bake into a new Creation.

use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::{self, resolve_ffmpeg};
use super::import_local::insert_local_creation;
use super::paths::ParascenePaths;
use super::reverse::ensure_reversed_media;
use super::thumb_fill::fill_and_record_local_thumb;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

const JOIN_FPS: f64 = 30.0;
const JOIN_OUT_W: u32 = 1280;
const JOIN_OUT_H: u32 = 720;
const DEFAULT_PREVIEW_HALF_WINDOW_SEC: f64 = 0.75;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinClipInput {
    pub asset_id: String,
    pub in_sec: f64,
    pub out_sec: f64,
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinStrategyInput {
    /// hard_cut | hold | fill | crossfade
    pub strategy: String,
    #[serde(default)]
    pub nudge_a_out_frames: i32,
    #[serde(default)]
    pub nudge_b_in_frames: i32,
    /// A | B
    #[serde(default = "default_hold_side")]
    pub hold_side: String,
    #[serde(default = "default_hold_frames")]
    pub hold_frames: u32,
    #[serde(default = "default_true")]
    pub remove_gap: bool,
    /// A | B | both
    #[serde(default = "default_fill_from")]
    pub fill_from: String,
    #[serde(default = "default_fill_frames")]
    pub fill_frames: u32,
    #[serde(default = "default_xfade_frames")]
    pub xfade_frames: u32,
}

fn default_hold_side() -> String {
    "A".into()
}
fn default_hold_frames() -> u32 {
    3
}
fn default_true() -> bool {
    true
}
fn default_fill_from() -> String {
    "A".into()
}
fn default_fill_frames() -> u32 {
    3
}
fn default_xfade_frames() -> u32 {
    6
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPreviewRequest {
    pub clip_a: JoinClipInput,
    pub clip_b: JoinClipInput,
    pub strategy: JoinStrategyInput,
    /// Half-window around the seam (seconds). Default 0.75.
    pub preview_half_window_sec: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinBakeRequest {
    pub clip_a: JoinClipInput,
    pub clip_b: JoinClipInput,
    pub strategy: JoinStrategyInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinPreviewResult {
    pub path: String,
    pub duration_sec: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinProgress {
    pub phase: String,
    pub done: u32,
    pub total: u32,
}

#[derive(Clone, Debug)]
struct ResolvedClip {
    path: PathBuf,
    in_sec: f64,
    out_sec: f64,
    title_hint: String,
}

fn frames_to_sec(frames: i32) -> f64 {
    frames as f64 / JOIN_FPS
}

fn frames_u_to_sec(frames: u32) -> f64 {
    frames as f64 / JOIN_FPS
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

fn validate_trim(label: &str, in_sec: f64, out_sec: f64) -> Result<(f64, f64), String> {
    if !in_sec.is_finite() || !out_sec.is_finite() {
        return Err(format!("{label} has invalid trim values"));
    }
    if in_sec < 0.0 {
        return Err(format!("{label} starts before 0"));
    }
    if out_sec <= in_sec + 1.0 / JOIN_FPS * 0.5 {
        return Err(format!("{label} has no positive duration"));
    }
    Ok((in_sec, out_sec))
}

fn apply_nudges(
    clip_a: &JoinClipInput,
    clip_b: &JoinClipInput,
    strategy: &JoinStrategyInput,
) -> Result<(f64, f64, f64, f64), String> {
    let (a_in, a_out) = validate_trim("Clip A", clip_a.in_sec, clip_a.out_sec)?;
    let (b_in, b_out) = validate_trim("Clip B", clip_b.in_sec, clip_b.out_sec)?;
    let a_out_n = (a_out + frames_to_sec(strategy.nudge_a_out_frames)).max(a_in + 1.0 / JOIN_FPS);
    let b_in_n = (b_in + frames_to_sec(strategy.nudge_b_in_frames))
        .max(0.0)
        .min(b_out - 1.0 / JOIN_FPS);
    Ok((a_in, a_out_n, b_in_n, b_out))
}

fn resolve_clip(
    paths: &ParascenePaths,
    input: &JoinClipInput,
    in_sec: f64,
    out_sec: f64,
) -> Result<ResolvedClip, String> {
    let conn = ready_connection(paths)?;
    let creation = get_creation_by_id(&conn, &input.asset_id)?
        .ok_or_else(|| format!("Creation not found: {}", input.asset_id))?;
    if !creation.media_type.eq_ignore_ascii_case("video") {
        return Err(format!(
            "Only video creations can be joined: {}",
            input.asset_id
        ));
    }
    let local_path = if input.reverse {
        ensure_reversed_media(paths, &creation)?.path
    } else {
        creation
            .local_path
            .clone()
            .ok_or_else(|| format!("No local media on disk yet for {}", input.asset_id))?
    };
    let src = path_under_root(&paths.root, &local_path)?;
    Ok(ResolvedClip {
        path: src,
        in_sec,
        out_sec,
        title_hint: creation.title.clone(),
    })
}

fn normalize_vfilter(label_in: &str, label_out: &str) -> String {
    // Match export language: fit into 16:9 stage, fps=30, yuv420p.
    format!(
        "[{label_in}]scale={JOIN_OUT_W}:{JOIN_OUT_H}:force_original_aspect_ratio=decrease,pad={JOIN_OUT_W}:{JOIN_OUT_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={JOIN_FPS},format=yuv420p[{label_out}]"
    )
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
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "ffmpeg join failed (exit {}): {}",
        output.status,
        if tail.is_empty() {
            "unknown error".into()
        } else {
            tail
        }
    ))
}

fn emit_progress(app: &AppHandle, phase: &str, done: u32, total: u32) {
    let _ = app.emit(
        "library-join-progress",
        JoinProgress {
            phase: phase.into(),
            done,
            total,
        },
    );
}

/// Build filter_complex for full A + strategy + B (bake), or windowed preview.
/// Returns (filter_complex, expected_duration_sec).
fn build_join_filter(
    a: &ResolvedClip,
    b: &ResolvedClip,
    strategy: &JoinStrategyInput,
    preview_window: Option<(f64, f64)>,
) -> Result<(String, f64), String> {
    let a_dur = a.out_sec - a.in_sec;
    let b_dur = b.out_sec - b.in_sec;
    if a_dur <= 0.0 || b_dur <= 0.0 {
        return Err("Join clips must have positive duration after nudges".into());
    }

    let strategy_key = strategy.strategy.trim().to_ascii_lowercase();

    // For preview, shrink A/B trims to the half-window around the seam.
    let (a_in, a_out, b_in, b_out) = if let Some((half, _)) = preview_window {
        let half = half.max(1.0 / JOIN_FPS);
        let a_start = (a.out_sec - half).max(a.in_sec);
        let b_end = (b.in_sec + half).min(b.out_sec);
        (
            a_start,
            a.out_sec,
            b.in_sec,
            b_end.max(b.in_sec + 1.0 / JOIN_FPS),
        )
    } else {
        (a.in_sec, a.out_sec, b.in_sec, b.out_sec)
    };

    let a_use = a_out - a_in;
    let b_use = b_out - b_in;

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "[0:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[a0]",
        a_in, a_out
    ));
    parts.push(format!(
        "[1:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[b0]",
        b_in, b_out
    ));
    parts.push(normalize_vfilter("a0", "a"));
    parts.push(normalize_vfilter("b0", "b"));

    let duration = match strategy_key.as_str() {
        "hold" => {
            let hold_sec = frames_u_to_sec(strategy.hold_frames.max(1));
            if strategy.hold_side.eq_ignore_ascii_case("B") {
                parts.push(format!(
                    "[b]tpad=start_mode=clone:start_duration={hold_sec:.3}[bpad];[a][bpad]concat=n=2:v=1:a=0[vout]"
                ));
            } else {
                parts.push(format!(
                    "[a]tpad=stop_mode=clone:stop_duration={hold_sec:.3}[apad];[apad][b]concat=n=2:v=1:a=0[vout]"
                ));
            }
            a_use + hold_sec + b_use
        }
        "fill" => {
            let fill_sec = frames_u_to_sec(strategy.fill_frames.max(1));
            let from = strategy.fill_from.to_ascii_lowercase();
            let _ = strategy.remove_gap; // gap is never encoded; fill replaces it
            match from.as_str() {
                "b" => {
                    parts.push(format!(
                        "[b]tpad=start_mode=clone:start_duration={fill_sec:.3}[bpad];[a][bpad]concat=n=2:v=1:a=0[vout]"
                    ));
                }
                "both" => {
                    let half = fill_sec / 2.0;
                    parts.push(format!(
                        "[a]tpad=stop_mode=clone:stop_duration={half:.3}[apad];[b]tpad=start_mode=clone:start_duration={half:.3}[bpad];[apad][bpad]concat=n=2:v=1:a=0[vout]"
                    ));
                }
                _ => {
                    parts.push(format!(
                        "[a]tpad=stop_mode=clone:stop_duration={fill_sec:.3}[apad];[apad][b]concat=n=2:v=1:a=0[vout]"
                    ));
                }
            }
            a_use + fill_sec + b_use
        }
        "crossfade" => {
            let mut xfade_sec = frames_u_to_sec(strategy.xfade_frames.max(1));
            xfade_sec = xfade_sec
                .min(a_use - 1.0 / JOIN_FPS)
                .min(b_use - 1.0 / JOIN_FPS)
                .max(1.0 / JOIN_FPS);
            let offset = (a_use - xfade_sec).max(0.0);
            parts.push(format!(
                "[a][b]xfade=transition=fade:duration={xfade_sec:.3}:offset={offset:.3}[vout]"
            ));
            a_use + b_use - xfade_sec
        }
        _ => {
            parts.push("[a][b]concat=n=2:v=1:a=0[vout]".into());
            a_use + b_use
        }
    };

    Ok((parts.join(";"), duration))
}

fn encode_join(
    ffmpeg: &Path,
    a: &ResolvedClip,
    b: &ResolvedClip,
    strategy: &JoinStrategyInput,
    output_path: &Path,
    preview_half_window_sec: Option<f64>,
) -> Result<f64, String> {
    let preview_window = preview_half_window_sec.map(|half| (half, half));
    let (filter, duration) = build_join_filter(a, b, strategy, preview_window)?;
    let frames = (duration * JOIN_FPS).round().max(1.0) as u64;

    let mut args: Vec<String> = Vec::new();
    args.push("-y".into());
    args.push("-i".into());
    args.push(a.path.display().to_string());
    args.push("-i".into());
    args.push(b.path.display().to_string());
    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[vout]".into());
    args.push("-an".into());
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push("20".into());
    args.push("-frames:v".into());
    args.push(frames.to_string());
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output_path.display().to_string());

    run_ffmpeg(ffmpeg, &args)?;
    if !output_path.is_file() {
        return Err("ffmpeg join produced no output file".into());
    }
    Ok(frames as f64 / JOIN_FPS)
}

fn run_join_preview(req: JoinPreviewRequest) -> Result<JoinPreviewResult, String> {
    let paths = default_paths()?;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required for Join Studio. Install with: brew install ffmpeg".to_string()
    })?;

    let (a_in, a_out, b_in, b_out) = apply_nudges(&req.clip_a, &req.clip_b, &req.strategy)?;
    let a = resolve_clip(&paths, &req.clip_a, a_in, a_out)?;
    let b = resolve_clip(&paths, &req.clip_b, b_in, b_out)?;

    let cache_dir = paths.cache.join("join-preview");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("Could not create join cache: {e}"))?;
    let out = cache_dir.join(format!(
        "join-preview-{}-{}.mp4",
        Utc::now().timestamp_millis(),
        std::process::id()
    ));

    let half = req
        .preview_half_window_sec
        .unwrap_or(DEFAULT_PREVIEW_HALF_WINDOW_SEC)
        .clamp(0.1, 5.0);

    let duration = encode_join(&ffmpeg, &a, &b, &req.strategy, &out, Some(half))?;
    Ok(JoinPreviewResult {
        path: out.display().to_string(),
        duration_sec: duration,
    })
}

fn new_join_id() -> String {
    format!(
        "local-join-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
}

fn run_join_bake(app: &AppHandle, req: JoinBakeRequest) -> Result<Creation, String> {
    let paths = default_paths()?;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required for Join Studio. Install with: brew install ffmpeg".to_string()
    })?;

    emit_progress(app, "prepare", 0, 2);
    let (a_in, a_out, b_in, b_out) = apply_nudges(&req.clip_a, &req.clip_b, &req.strategy)?;
    let a = resolve_clip(&paths, &req.clip_a, a_in, a_out)?;
    emit_progress(app, "prepare", 1, 2);
    let b = resolve_clip(&paths, &req.clip_b, b_in, b_out)?;
    emit_progress(app, "prepare", 2, 2);

    let id = new_join_id();
    let filename = format!("{}.mp4", safe_id(&id));
    let output_path = paths.media.join(&filename);
    let output_str = output_path.display().to_string();

    emit_progress(app, "join", 0, 1);
    let _duration = encode_join(&ffmpeg, &a, &b, &req.strategy, &output_path, None)?;
    emit_progress(app, "join", 1, 1);

    let base = a.title_hint.trim();
    let title = if base.is_empty() {
        "Joined clip".to_string()
    } else {
        format!("{base} joined")
    };

    {
        let conn = ready_connection(&paths)?;
        insert_local_creation(
            &conn,
            &id,
            &title,
            "video",
            &filename,
            &output_str,
            None,
            None,
            None,
            None,
        )?;
    }

    emit_progress(app, "catalog", 0, 1);
    let mut creation = {
        let conn = ready_connection(&paths)?;
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after insert"))?
    };
    {
        let conn = ready_connection(&paths)?;
        let _ = fill_and_record_local_thumb(&paths, &conn, &creation);
    }
    let conn = ready_connection(&paths)?;
    creation =
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after thumb"))?;
    let _ = app.emit("library-creation-updated", &creation);
    emit_progress(app, "catalog", 1, 1);
    Ok(creation)
}

#[tauri::command]
pub async fn library_join_preview(req: JoinPreviewRequest) -> Result<JoinPreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_join_preview(req))
        .await
        .map_err(|e| format!("Join preview task failed: {e}"))?
}

#[tauri::command]
pub async fn library_join_bake(app: AppHandle, req: JoinBakeRequest) -> Result<Creation, String> {
    let app_for_block = app.clone();
    tauri::async_runtime::spawn_blocking(move || run_join_bake(&app_for_block, req))
        .await
        .map_err(|e| format!("Join bake task failed: {e}"))?
}
