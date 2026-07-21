//! Ensure a behind-the-scenes reversed copy of local media via FFmpeg.
//!
//! Writes under `Cache/reversed/v2/{id}.reversed.{ext}` (plus a first-frame
//! `.reversed.thumb.jpg` for video) and reuses those files when present.
//! Concurrent callers for the same asset are serialized; encodes land via
//! temp + rename so two writers cannot corrupt one destination.

use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::clip_thumb::delete_clip_thumbs_for_asset;
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

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

fn reverse_gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate_for_asset(id: &str) -> Arc<Mutex<()>> {
    let mut map = reverse_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
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
    // v2: CFR / no-B-frame reverses (v1 open-GOP files freeze HW playback).
    let dir = paths.cache.join("reversed").join("v2");
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
        .join("v2")
        .join(format!("{stem}.reversed.thumb.jpg"))
}

fn partial_path(dest: &Path) -> PathBuf {
    // FFmpeg sniffs format from the *final* extension. Keep the dest extension
    // at the end: `{stem}.partial.{pid}.{nanos}.{ext}` (e.g. `.mp4` / `.m4a`).
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("reversed");
    let ext = dest
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let name = format!(
        "{stem}.partial.{}.{}.{ext}",
        std::process::id(),
        nanos
    );
    dest.with_file_name(name)
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

fn file_nonempty(path: &Path) -> bool {
    path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

fn publish_partial(partial: &Path, dest: &Path) -> Result<(), String> {
    if !file_nonempty(partial) {
        let _ = fs::remove_file(partial);
        return Err("ffmpeg reverse produced no output file".into());
    }
    let _ = fs::remove_file(dest);
    fs::rename(partial, dest).map_err(|e| {
        let _ = fs::remove_file(partial);
        format!("Could not finalize reversed media: {e}")
    })?;
    Ok(())
}

/// Confirm a reversed video can decode at least one frame (catches corrupt
/// caches from concurrent writers / truncated encodes).
fn verify_reversed_video(ffmpeg: &Path, path: &Path) -> Result<(), String> {
    let path_s = path.display().to_string();
    run_ffmpeg(
        ffmpeg,
        &[
            "-v",
            "error",
            "-i",
            &path_s,
            "-an",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ],
    )
    .map_err(|e| format!("Reversed video is unreadable (will rebuild): {e}"))
}

fn reverse_video(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.display().to_string();
    let partial = partial_path(dest);
    let partial_s = partial.display().to_string();
    // Prefer A/V reverse; fall back to silent video when the source has no audio.
    // No B-frames + explicit CFR timestamps: reversed files with open-GOP B-frames
    // (negative DTS) confuse later trim/concat and HW playback.
    // Always encode to a unique partial path, then rename — concurrent `-y` writes
    // to the same dest produced duplicated MOOV / undecodable NAL caches.
    let with_audio = run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vf",
            "reverse,setpts=PTS-STARTPTS",
            "-af",
            "areverse,asetpts=PTS-STARTPTS",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            &partial_s,
        ],
    );
    if with_audio.is_ok() {
        publish_partial(&partial, dest)?;
        verify_reversed_video(ffmpeg, dest).map_err(|e| {
            let _ = fs::remove_file(dest);
            e
        })?;
        return Ok(());
    }
    let _ = fs::remove_file(&partial);
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &src_s,
            "-vf",
            "reverse,setpts=PTS-STARTPTS",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-bf",
            "0",
            "-movflags",
            "+faststart",
            &partial_s,
        ],
    )?;
    publish_partial(&partial, dest)?;
    verify_reversed_video(ffmpeg, dest).map_err(|e| {
        let _ = fs::remove_file(dest);
        e
    })?;
    Ok(())
}

fn reverse_audio(ffmpeg: &Path, src: &Path, dest: &Path) -> Result<(), String> {
    let src_s = src.display().to_string();
    let partial = partial_path(dest);
    let partial_s = partial.display().to_string();
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
            &partial_s,
        ],
    )?;
    publish_partial(&partial, dest)
}

/// First frame of the reversed video — matches what preview/timeline show at t=0.
fn extract_reversed_thumb(ffmpeg: &Path, video: &Path, dest: &Path) -> Result<(), String> {
    let partial = partial_path(dest);
    let video_s = video.display().to_string();
    let partial_s = partial.display().to_string();
    // FFmpeg 7+/8 image2 wants `-update 1` for a single still; map video explicitly
    // and force a JPEG-friendly pixel format.
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            &video_s,
            "-an",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=720:-2:flags=lanczos,format=yuvj420p",
            "-q:v",
            "2",
            "-update",
            "1",
            &partial_s,
        ],
    )?;
    publish_partial(&partial, dest)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReversedMedia {
    pub path: String,
    pub thumb_path: Option<String>,
}

pub(crate) fn ensure_reversed_media(
    paths: &ParascenePaths,
    creation: &Creation,
) -> Result<ReversedMedia, String> {
    // Preview + clip-thumb + timeline can all request the same reverse at once.
    let gate = gate_for_asset(&creation.id);
    let _guard = gate.lock().unwrap_or_else(|e| e.into_inner());

    let Some(local) = creation.local_path.as_deref().filter(|p| !p.is_empty()) else {
        return Err("No local media on disk yet — wait for download, then try again.".into());
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

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to reverse media. Install with: brew install ffmpeg".to_string()
    })?;

    let mut dest_usable = file_nonempty(&dest);
    // Drop corrupt caches (e.g. duplicated MOOV from an earlier race) so we rebuild.
    if dest_usable && is_video {
        if verify_reversed_video(&ffmpeg, &dest).is_err() {
            let _ = fs::remove_file(&dest);
            dest_usable = false;
        }
    }

    let thumb_dest_path = if is_video {
        Some(reversed_thumb_dest(paths, creation))
    } else {
        None
    };
    let need_thumb = thumb_dest_path.as_ref().is_some_and(|p| !file_nonempty(p));
    let need_media = !dest_usable;
    let mut produced_video = is_video && dest_usable;

    if need_media {
        if is_video {
            let video_result = reverse_video(&ffmpeg, &src, &dest);
            match video_result {
                Ok(()) => {
                    produced_video = true;
                }
                Err(video_err) => {
                    let _ = fs::remove_file(&dest);
                    // Only fall back when the catalog type is ambiguous (container
                    // looked like video). Hard-tagged video must not become audio.
                    let tagged_video = creation.media_type.trim().eq_ignore_ascii_case("video");
                    if tagged_video {
                        return Err(video_err);
                    }
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
            if need_thumb || !file_nonempty(thumb) {
                // Thumb is best-effort — a readable reverse is enough to preview.
                if let Err(err) = extract_reversed_thumb(&ffmpeg, &dest, thumb) {
                    eprintln!("reversed thumb skipped for {}: {err}", creation.id);
                    let _ = fs::remove_file(thumb);
                }
            }
        }
    }

    let thumb_path = thumb_dest_path
        .filter(|p| produced_video && file_nonempty(p))
        .map(|p| p.display().to_string());

    Ok(ReversedMedia {
        path: dest.display().to_string(),
        thumb_path,
    })
}

/// Remove any cached reversed media (+ thumb) for a creation, ignoring absent files.
fn delete_reversed_cache(paths: &ParascenePaths, creation: &Creation) -> Result<(), String> {
    let Some(local) = creation.local_path.as_deref().filter(|p| !p.is_empty()) else {
        return Ok(());
    };
    let src = path_under_root(&paths.root, local)?;
    let dest = reversed_dest(paths, creation, &src);
    if dest.is_file() {
        fs::remove_file(&dest).map_err(|e| format!("Could not delete reversed media: {e}"))?;
    }
    let thumb = reversed_thumb_dest(paths, creation);
    if thumb.is_file() {
        let _ = fs::remove_file(&thumb);
    }
    Ok(())
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

/// Force-rebuild reversed media for the given creation ids: delete the cached
/// files, then regenerate. Missing / non-reversible ids are skipped. Returns
/// the number of assets rebuilt.
#[tauri::command]
pub async fn library_rebuild_reversed(ids: Vec<String>) -> Result<usize, String> {
    let paths = default_paths()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ready_connection(&paths)?;
        let mut rebuilt = 0usize;
        let mut seen: Vec<String> = Vec::new();
        for id in ids {
            let id = id.trim().to_string();
            if id.is_empty() || seen.contains(&id) {
                continue;
            }
            seen.push(id.clone());
            let Some(creation) = get_creation_by_id(&conn, &id)? else {
                continue;
            };
            // Skip assets that can't be reversed (e.g. stills) instead of failing.
            let has_local = creation
                .local_path
                .as_deref()
                .is_some_and(|p| !p.is_empty());
            if !has_local {
                continue;
            }
            let src = match path_under_root(&paths.root, creation.local_path.as_deref().unwrap()) {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !is_video_creation(&creation, &src) && !is_audio_creation(&creation, &src) {
                continue;
            }
            delete_reversed_cache(&paths, &creation)?;
            delete_clip_thumbs_for_asset(&paths, &id)?;
            ensure_reversed_media(&paths, &creation)?;
            rebuilt += 1;
        }
        Ok(rebuilt)
    })
    .await
    .map_err(|e| format!("Rebuild reversed task failed: {e}"))?
}
