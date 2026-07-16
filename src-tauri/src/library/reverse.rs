//! Ensure a behind-the-scenes reversed copy of local media via FFmpeg.
//!
//! Writes under `Cache/reversed/{id}.reversed.{ext}` (plus a first-frame
//! `.reversed.thumb.jpg` for video) and reuses those files when present.

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
    // Catalog type wins — audio often lives in .mp4/.m4a containers.
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

fn is_audio_creation(creation: &Creation, local_path: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "audio" {
        return true;
    }
    if mt == "video" || mt == "image" {
        return false;
    }
    matches!(
        local_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "aiff" | "aif")
    )
}

fn reversed_dest(paths: &ParascenePaths, creation: &Creation, src: &Path) -> PathBuf {
    let stem = safe_id(&creation.id);
    let dir = paths.cache.join("reversed");
    if is_video_creation(creation, src) {
        dir.join(format!("{stem}.reversed.mp4"))
    } else {
        // Always m4a so AAC encode is valid in-container for HTML audio.
        dir.join(format!("{stem}.reversed.m4a"))
    }
}

fn reversed_thumb_dest(paths: &ParascenePaths, creation: &Creation) -> PathBuf {
    let stem = safe_id(&creation.id);
    paths
        .cache
        .join("reversed")
        .join(format!("{stem}.reversed.thumb.jpg"))
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
            "ffmpeg reverse failed (exit {}): {}",
            output.status,
            if tail.is_empty() {
                "unknown error".into()
            } else {
                tail
            }
        ))
    }
}

fn reverse_video(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.display().to_string();
    let dest_s = dest.display().to_string();
    // Prefer A/V reverse; fall back to silent video when the source has no audio.
    let with_audio = run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vf",
            "reverse",
            "-af",
            "areverse",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-c:a",
            "aac",
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
            "reverse",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-movflags",
            "+faststart",
            &dest_s,
        ],
    )?;
    if dest.is_file() {
        Ok(())
    } else {
        Err("ffmpeg reverse produced no output file".into())
    }
}

fn reverse_audio(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.display().to_string();
    let dest_s = dest.display().to_string();
    // Explicit -vn: sources may be audio-only .mp4; never open a video encoder.
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vn",
            "-af",
            "areverse",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            &dest_s,
        ],
    )?;
    if dest.is_file() {
        Ok(())
    } else {
        Err("ffmpeg reverse produced no output file".into())
    }
}

/// First frame of the reversed video — matches what preview/timeline show at t=0.
fn extract_reversed_thumb(ffmpeg: &Path, video: &Path, dest: &Path) -> Result<(), String> {
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &video.display().to_string(),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            &dest.display().to_string(),
        ],
    )?;
    if dest.is_file() {
        Ok(())
    } else {
        Err("ffmpeg produced no reversed thumb".into())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReversedMedia {
    pub path: String,
    pub thumb_path: Option<String>,
}

fn ensure_reversed_media(
    paths: &ParascenePaths,
    creation: &Creation,
) -> Result<ReversedMedia, String> {
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
    let is_video = is_video_creation(creation, &src);
    let is_audio = is_audio_creation(creation, &src);
    if !is_video && !is_audio {
        return Err("Reverse is only available for video and audio assets".into());
    }

    let dest = reversed_dest(paths, creation, &src);
    let dir = dest
        .parent()
        .ok_or_else(|| "Invalid reversed cache path".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create reverse cache: {e}"))?;

    let dest_usable = dest.is_file()
        && dest
            .metadata()
            .map(|m| m.len() > 0)
            .unwrap_or(false);
    if dest.is_file() && !dest_usable {
        let _ = fs::remove_file(&dest);
    }

    let need_media = !dest_usable;
    let thumb_dest_path = if is_video {
        Some(reversed_thumb_dest(paths, creation))
    } else {
        None
    };
    let need_thumb = thumb_dest_path.as_ref().is_some_and(|p| !p.is_file());
    let mut produced_video = is_video && dest.is_file() && !need_media;

    if need_media || need_thumb {
        let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
            "FFmpeg is required to reverse media. Install with: brew install ffmpeg"
                .to_string()
        })?;

        if need_media {
            if is_video {
                match reverse_video(&ffmpeg, &src, &dest) {
                    Ok(()) => {
                        produced_video = true;
                    }
                    // Audio-only file mis-tagged / in a video container.
                    Err(video_err) => {
                        let _ = fs::remove_file(&dest);
                        reverse_audio(&ffmpeg, &src, &dest).map_err(|audio_err| {
                            format!("{video_err}\n(audio fallback also failed: {audio_err})")
                        })?;
                        produced_video = false;
                    }
                }
            } else {
                reverse_audio(&ffmpeg, &src, &dest)?;
                produced_video = false;
            }
        }

        if produced_video {
            if let Some(thumb) = thumb_dest_path.as_ref() {
                if !thumb.is_file() {
                    extract_reversed_thumb(&ffmpeg, &dest, thumb)?;
                }
            }
        }
    }

    let thumb_path = thumb_dest_path
        .filter(|p| produced_video && p.is_file())
        .map(|p| p.display().to_string());

    Ok(ReversedMedia {
        path: dest.display().to_string(),
        thumb_path,
    })
}

/// Return paths for a cached reversed copy (+ first-frame thumb for video).
#[tauri::command]
pub async fn library_ensure_reversed(id: String) -> Result<ReversedMedia, String> {
    let paths = default_paths()?;
    let id_for_block = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ready_connection(&paths)?;
        let creation = get_creation_by_id(&conn, &id_for_block)?
            .ok_or_else(|| format!("Creation not found: {id_for_block}"))?;
        ensure_reversed_media(&paths, &creation)
    })
    .await
    .map_err(|e| format!("Reverse task failed: {e}"))?
}
