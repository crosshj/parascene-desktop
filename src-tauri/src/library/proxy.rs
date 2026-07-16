//! Normalized H.264 preview proxies via CLI FFmpeg.
//!
//! Writes under `Cache/proxies/{id}.proxy.mp4` and reuses those files when present.
//! Format: H.264, ≤1280×720, 30 fps, yuv420p, keyframe every 10 frames, AAC.

use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use serde::Serialize;
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
    if !file_canon.starts_with(&root_canon) {
        return Err("Local media path is outside the Parascene library".into());
    }
    if !file_canon.is_file() {
        return Err("Local media file not found".into());
    }
    Ok(file_canon)
}

fn is_video_creation(creation: &Creation, local_path: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "video" {
        return true;
    }
    if mt == "audio" || mt == "image" {
        return false;
    }
    matches!(
        local_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mov" | "webm" | "mkv" | "m4v")
    )
}

fn proxy_dest(paths: &ParascenePaths, creation: &Creation) -> PathBuf {
    let stem = safe_id(&creation.id);
    paths.cache.join("proxies").join(format!("{stem}.proxy.mp4"))
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
        let tail = err
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "ffmpeg proxy failed (exit {}): {}",
            output.status,
            if tail.is_empty() {
                "unknown error".into()
            } else {
                tail
            }
        ))
    }
}

fn encode_proxy(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.display().to_string();
    let dest_s = dest.display().to_string();
    // Scale to fit inside 1280×720, even dims; constant 30 fps; GOP 10.
    let with_audio = run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vf",
            "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "10",
            "-keyint_min",
            "10",
            "-sc_threshold",
            "0",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            &dest_s,
        ],
    );
    if with_audio.is_ok() && dest.is_file() {
        return Ok(());
    }
    let _ = fs::remove_file(dest);
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vf",
            "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "10",
            "-keyint_min",
            "10",
            "-sc_threshold",
            "0",
            "-movflags",
            "+faststart",
            &dest_s,
        ],
    )?;
    if dest.is_file() {
        Ok(())
    } else {
        Err("ffmpeg proxy produced no output file".into())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMedia {
    pub path: String,
}

fn ensure_proxy_media(paths: &ParascenePaths, creation: &Creation) -> Result<ProxyMedia, String> {
    let Some(local) = creation
        .local_path
        .as_deref()
        .filter(|p| !p.is_empty())
    else {
        return Err(
            "No local media on disk yet — wait for download, then try again.".into(),
        );
    };
    let src = path_under_root(&paths.root, local)?;
    if !is_video_creation(creation, &src) {
        return Err("Preview proxies are only available for video assets".into());
    }

    let dest = proxy_dest(paths, creation);
    let dir = dest
        .parent()
        .ok_or_else(|| "Invalid proxy cache path".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create proxy cache: {e}"))?;

    let dest_usable = dest.is_file()
        && dest
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false);
    if dest.is_file() && !dest_usable {
        let _ = fs::remove_file(&dest);
    }

    if !dest_usable {
        let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
            "FFmpeg is required to build preview proxies. Install with: brew install ffmpeg"
                .to_string()
        })?;
        encode_proxy(&ffmpeg, &src, &dest)?;
    }

    Ok(ProxyMedia {
        path: dest.display().to_string(),
    })
}

/// Return the path for a cached normalized preview proxy.
#[tauri::command]
pub async fn library_ensure_proxy(id: String) -> Result<ProxyMedia, String> {
    let paths = default_paths()?;
    let id_for_block = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ready_connection(&paths)?;
        let creation = get_creation_by_id(&conn, &id_for_block)?
            .ok_or_else(|| format!("Creation not found: {id_for_block}"))?;
        ensure_proxy_media(&paths, &creation)
    })
    .await
    .map_err(|e| format!("Proxy task failed: {e}"))?
}
