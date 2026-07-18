//! Cached first-frame thumbnails for trimmed timeline clips.

use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use super::reverse::ensure_reversed_media;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    if !file_canon.starts_with(&root_canon) || !file_canon.is_file() {
        return Err("Local media path is outside the Parascene library".into());
    }
    Ok(file_canon)
}

fn cache_dir(paths: &ParascenePaths) -> PathBuf {
    paths.cache.join("clip-thumbs").join("v1")
}

fn cache_path(paths: &ParascenePaths, id: &str, reverse: bool, time_sec: f64) -> PathBuf {
    let millis = (time_sec.max(0.0) * 1000.0).round() as u64;
    cache_dir(paths).join(format!(
        "{}-{}-{millis}.jpg",
        safe_id(id),
        if reverse { "r" } else { "f" }
    ))
}

fn source_path(
    paths: &ParascenePaths,
    creation: &Creation,
    reverse: bool,
) -> Result<PathBuf, String> {
    if reverse {
        return Ok(PathBuf::from(ensure_reversed_media(paths, creation)?.path));
    }
    let local = creation
        .local_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "No local media on disk yet".to_string())?;
    path_under_root(&paths.root, local)
}

fn extract_frame(source: &Path, time_sec: f64, dest: &Path) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to create clip thumbnails. Install with: brew install ffmpeg"
            .to_string()
    })?;
    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            &source.display().to_string(),
            "-ss",
            &format!("{:.3}", time_sec.max(0.0)),
            "-an",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=720:720:force_original_aspect_ratio=decrease,format=yuvj420p",
            "-q:v",
            "2",
            "-update",
            "1",
            &dest.display().to_string(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() && dest.is_file() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let tail = err.lines().rev().take(5).collect::<Vec<_>>();
    Err(format!(
        "FFmpeg failed extracting clip frame: {}",
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    ))
}

fn ensure_clip_thumb(
    paths: &ParascenePaths,
    creation: &Creation,
    reverse: bool,
    time_sec: f64,
) -> Result<PathBuf, String> {
    let dest = cache_path(paths, &creation.id, reverse, time_sec);
    if dest.is_file() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(dest);
    }
    fs::create_dir_all(cache_dir(paths))
        .map_err(|e| format!("Could not create clip thumbnail cache: {e}"))?;
    let source = source_path(paths, creation, reverse)?;
    extract_frame(&source, time_sec, &dest)?;
    Ok(dest)
}

pub(crate) fn delete_clip_thumbs_for_asset(
    paths: &ParascenePaths,
    asset_id: &str,
) -> Result<(), String> {
    let dir = cache_dir(paths);
    if !dir.is_dir() {
        return Ok(());
    }
    let prefix = format!("{}-", safe_id(asset_id));
    for entry in
        fs::read_dir(&dir).map_err(|e| format!("Could not read clip thumbnail cache: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Could not read clip thumbnail entry: {e}"))?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn library_ensure_clip_thumb(
    id: String,
    reverse: bool,
    time_sec: f64,
) -> Result<String, String> {
    let paths = default_paths()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ready_connection(&paths)?;
        let creation = get_creation_by_id(&conn, id.trim())?
            .ok_or_else(|| format!("Creation not found: {}", id.trim()))?;
        ensure_clip_thumb(&paths, &creation, reverse, time_sec)
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|e| format!("Clip thumbnail task failed: {e}"))?
}
