use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, set_local_thumb_path, Creation,
};
use super::ffmpeg::resolve_ffmpeg;
use super::import_local::insert_local_creation;
use super::paths::ParascenePaths;
use super::reverse::ensure_reversed_media;
use super::thumb_fill::fill_local_thumb;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeTimelineClipInput {
    pub asset_id: String,
    pub in_sec: Option<f64>,
    pub out_sec: Option<f64>,
    #[serde(default)]
    pub reverse: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeProgress {
    pub phase: String,
    pub done: u32,
    pub total: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeFinished {
    pub ok: bool,
    pub creation_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct MergeSource {
    path: PathBuf,
    in_sec: f64,
    out_sec: f64,
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

fn validate_trim(index: usize, input: &MergeTimelineClipInput) -> Result<(f64, f64), String> {
    let in_sec = input.in_sec.unwrap_or(0.0);
    let out_sec = input.out_sec.unwrap_or(in_sec + 0.1);
    if !in_sec.is_finite() || !out_sec.is_finite() {
        return Err(format!("Clip {} has invalid trim values", index + 1));
    }
    if in_sec < 0.0 {
        return Err(format!("Clip {} starts before 0", index + 1));
    }
    if out_sec <= in_sec {
        return Err(format!("Clip {} has no positive duration", index + 1));
    }
    Ok((in_sec, out_sec))
}

fn new_merge_id() -> String {
    format!(
        "local-merge-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
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
        "ffmpeg merge failed (exit {}): {}",
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
        "library-merge-progress",
        MergeProgress {
            phase: phase.into(),
            done,
            total,
        },
    );
}

fn emit_finished(app: &AppHandle, ok: bool, creation_id: Option<String>, error: Option<String>) {
    let _ = app.emit(
        "library-merge-finished",
        MergeFinished {
            ok,
            creation_id,
            error,
        },
    );
}

fn resolve_source(
    paths: &ParascenePaths,
    input: &MergeTimelineClipInput,
) -> Result<(Creation, PathBuf), String> {
    let conn = ready_connection(paths)?;
    let creation = get_creation_by_id(&conn, &input.asset_id)?
        .ok_or_else(|| format!("Creation not found: {}", input.asset_id))?;
    if !creation.media_type.eq_ignore_ascii_case("video") {
        return Err(format!(
            "Only video creations can be merged: {}",
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
    Ok((creation, src))
}

fn merge_title(first: &Creation, count: usize) -> String {
    let base = first.title.trim();
    if base.is_empty() {
        format!("Merged clip ({count} clips)")
    } else {
        format!("{base} merged ({count} clips)")
    }
}

fn merge_filename(id: &str) -> String {
    format!("{}.mp4", safe_id(id))
}

fn run_merge(app: &AppHandle, clips: Vec<MergeTimelineClipInput>) -> Result<Creation, String> {
    if clips.len() < 2 {
        return Err("Select at least two contiguous video clips to merge".into());
    }
    let paths = default_paths()?;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to merge clips. Install with: brew install ffmpeg".to_string()
    })?;

    emit_progress(app, "prepare", 0, clips.len() as u32);

    let mut first_creation: Option<Creation> = None;
    let mut sources: Vec<MergeSource> = Vec::with_capacity(clips.len());
    for (index, input) in clips.iter().enumerate() {
        let (in_sec, out_sec) = validate_trim(index, input)?;
        let (creation, path) = resolve_source(&paths, input)?;
        if first_creation.is_none() {
            first_creation = Some(creation.clone());
        }
        sources.push(MergeSource {
            path,
            in_sec,
            out_sec,
        });
        emit_progress(app, "prepare", (index + 1) as u32, clips.len() as u32);
    }

    let first = first_creation.ok_or_else(|| "No source clips provided".to_string())?;
    let id = new_merge_id();
    let filename = merge_filename(&id);
    let output_path = paths.media.join(&filename);
    let output_str = output_path.display().to_string();

    let mut filter_parts: Vec<String> = Vec::with_capacity(sources.len() + 1);
    let mut args: Vec<String> = Vec::with_capacity(sources.len() * 2 + 16);
    args.push("-y".into());
    for (index, source) in sources.iter().enumerate() {
        args.push("-i".into());
        args.push(source.path.display().to_string());
        filter_parts.push(format!(
            "[{index}:v]trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS[v{index}]",
            source.in_sec, source.out_sec
        ));
    }
    let concat_inputs = (0..sources.len())
        .map(|index| format!("[v{index}]"))
        .collect::<String>();
    filter_parts.push(format!(
        "{concat_inputs}concat=n={}:v=1:a=0[vout]",
        sources.len()
    ));
    args.push("-filter_complex".into());
    args.push(filter_parts.join(";"));
    args.push("-map".into());
    args.push("[vout]".into());
    args.push("-an".into());
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push("20".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push(output_str.clone());

    emit_progress(app, "merge", 0, 1);
    run_ffmpeg(&ffmpeg, &args)?;
    if !output_path.is_file() {
        return Err("ffmpeg merge produced no output file".into());
    }
    emit_progress(app, "merge", 1, 1);

    let title = merge_title(&first, clips.len());
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
        )?;
    }

    emit_progress(app, "catalog", 0, 1);
    let mut creation = {
        let conn = ready_connection(&paths)?;
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after insert"))?
    };
    if let Ok(thumb) = fill_local_thumb(&paths, &creation) {
        let thumb_str = thumb.display().to_string();
        let conn = ready_connection(&paths)?;
        let _ = set_local_thumb_path(&conn, &id, &thumb_str);
    }
    let conn = ready_connection(&paths)?;
    creation =
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after thumb"))?;
    let _ = app.emit("library-creation-updated", &creation);
    emit_progress(app, "catalog", 1, 1);
    Ok(creation)
}

#[tauri::command]
pub async fn library_merge_timeline_clips(
    app: AppHandle,
    clips: Vec<MergeTimelineClipInput>,
) -> Result<Creation, String> {
    let app_for_block = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_merge(&app_for_block, clips))
        .await
        .map_err(|e| format!("Merge task failed: {e}"))?;
    match result {
        Ok(creation) => {
            emit_finished(&app, true, Some(creation.id.clone()), None);
            Ok(creation)
        }
        Err(error) => {
            emit_finished(&app, false, None, Some(error.clone()));
            Err(error)
        }
    }
}
