//! Dual normalized fragmented-MP4 proxies for timeline preview.
//!
//! Playback: long-GOP H.264 + AAC, frequent keyframes, CMAF-style fragments.
//! Scrub: all-intra lower-resolution proxy for responsive random access.
//! Shared invariants: 1280×720 / 640-wide, 30 fps, yuv420p, 48 kHz stereo AAC,
//! main profile, empty_moov + frag_keyframe + default_base_moof.

use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, set_proxy_fields, Creation,
};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const PROXY_VERSION: &str = "v1";
pub const PROXY_FPS: u32 = 30;
pub const PROXY_PLAY_W: u32 = 1280;
pub const PROXY_PLAY_H: u32 = 720;
pub const PROXY_SCRUB_W: u32 = 640;
pub const PROXY_SCRUB_H: u32 = 360;
/// Fragment / keyframe interval in frames (1s at 30fps).
pub const PROXY_GOP: u32 = 30;
pub const PROXY_CODEC_STRING: &str = r#"video/mp4; codecs="avc1.4D401F,mp4a.40.2""#;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyEnsureResult {
    pub creation_id: String,
    pub status: String,
    pub play_path: Option<String>,
    pub scrub_path: Option<String>,
    pub hash: Option<String>,
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

fn proxy_gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate_for(id: &str) -> Arc<Mutex<()>> {
    let mut map = proxy_gates()
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
        let tail: String = err.chars().rev().take(800).collect::<String>().chars().rev().collect();
        Err(format!("ffmpeg failed: {tail}"))
    }
}

fn partial_path(dest: &Path) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!(
        "{}.partial.{}.{}",
        dest.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("proxy"),
        std::process::id(),
        nanos
    );
    dest.with_file_name(name)
}

fn proxy_dir(paths: &ParascenePaths) -> PathBuf {
    paths.cache.join("proxies").join(PROXY_VERSION)
}

fn play_dest(paths: &ParascenePaths, id: &str) -> PathBuf {
    proxy_dir(paths).join(format!("{}.play.mp4", safe_id(id)))
}

fn scrub_dest(paths: &ParascenePaths, id: &str) -> PathBuf {
    proxy_dir(paths).join(format!("{}.scrub.mp4", safe_id(id)))
}

fn content_hash(src: &Path) -> Result<String, String> {
    let meta = fs::metadata(src).map_err(|e| format!("stat failed: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(format!(
        "{}-{}-{}-{}",
        PROXY_VERSION,
        meta.len(),
        modified,
        src.display()
    ))
}

fn is_image(creation: &Creation, src: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "image" {
        return true;
    }
    matches!(
        src.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "heic" | "avif")
    )
}

fn is_audio(creation: &Creation, src: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "audio" {
        return true;
    }
    if mt == "video" || mt == "image" {
        return false;
    }
    matches!(
        src.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "aiff" | "aif")
    )
}

fn scale_filter(w: u32, h: u32) -> String {
    format!(
        "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={PROXY_FPS},format=yuv420p"
    )
}

fn encode_playback_video(ffmpeg: &Path, src: &Path, dest: &Path, image: bool) -> Result<(), String> {
    let partial = partial_path(dest);
    let vf = scale_filter(PROXY_PLAY_W, PROXY_PLAY_H);
    let src_s = src.to_string_lossy();
    let vf_s = vf;
    let partial_s = partial.to_string_lossy();
    let gop = PROXY_GOP.to_string();

    if image {
        let out = Command::new(ffmpeg)
            .args([
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-loop",
                "1",
                "-t",
                "2",
                "-i",
                src_s.as_ref(),
                "-vf",
                vf_s.as_str(),
                "-c:v",
                "libx264",
                "-profile:v",
                "main",
                "-level",
                "4.0",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-g",
                gop.as_str(),
                "-keyint_min",
                gop.as_str(),
                "-sc_threshold",
                "0",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-b:a",
                "128k",
                "-shortest",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                partial_s.as_ref(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
            .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
        if !out.status.success() {
            let _ = fs::remove_file(&partial);
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("ffmpeg image proxy failed: {err}"));
        }
    } else {
        // Prefer audio when present; generate silent if missing.
        let has_audio = probe_has_audio(ffmpeg, src);
        if has_audio {
            run_ffmpeg(
                ffmpeg,
                &[
                    "-i",
                    src_s.as_ref(),
                    "-vf",
                    vf_s.as_str(),
                    "-c:v",
                    "libx264",
                    "-profile:v",
                    "main",
                    "-level",
                    "4.0",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-g",
                    gop.as_str(),
                    "-keyint_min",
                    gop.as_str(),
                    "-sc_threshold",
                    "0",
                    "-bf",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "128k",
                    "-movflags",
                    "frag_keyframe+empty_moov+default_base_moof",
                    "-f",
                    "mp4",
                    "-y",
                    partial_s.as_ref(),
                ],
            )?;
        } else {
            let out = Command::new(ffmpeg)
                .args([
                    "-i",
                    src_s.as_ref(),
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=48000:cl=stereo",
                    "-vf",
                    vf_s.as_str(),
                    "-c:v",
                    "libx264",
                    "-profile:v",
                    "main",
                    "-level",
                    "4.0",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-g",
                    gop.as_str(),
                    "-keyint_min",
                    gop.as_str(),
                    "-sc_threshold",
                    "0",
                    "-bf",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "128k",
                    "-shortest",
                    "-movflags",
                    "frag_keyframe+empty_moov+default_base_moof",
                    "-f",
                    "mp4",
                    "-y",
                    partial_s.as_ref(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output()
                .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
            if !out.status.success() {
                let _ = fs::remove_file(&partial);
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("ffmpeg silent-audio proxy failed: {err}"));
            }
        }
    }
    fs::rename(&partial, dest).map_err(|e| format!("rename proxy failed: {e}"))?;
    Ok(())
}

fn encode_scrub_video(ffmpeg: &Path, src: &Path, dest: &Path, image: bool) -> Result<(), String> {
    let partial = partial_path(dest);
    let vf = scale_filter(PROXY_SCRUB_W, PROXY_SCRUB_H);
    let src_s = src.to_string_lossy();
    let partial_s = partial.to_string_lossy();
    let vf_s = vf;

    let result = if image {
        Command::new(ffmpeg)
            .args([
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-loop",
                "1",
                "-t",
                "2",
                "-i",
                src_s.as_ref(),
                "-vf",
                vf_s.as_str(),
                "-c:v",
                "libx264",
                "-profile:v",
                "main",
                "-level",
                "3.1",
                "-preset",
                "ultrafast",
                "-crf",
                "28",
                "-g",
                "1",
                "-keyint_min",
                "1",
                "-sc_threshold",
                "0",
                "-bf",
                "0",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-ar",
                "48000",
                "-ac",
                "2",
                "-b:a",
                "96k",
                "-shortest",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "-y",
                partial_s.as_ref(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .output()
    } else {
        let has_audio = probe_has_audio(ffmpeg, src);
        if has_audio {
            Command::new(ffmpeg)
                .args([
                    "-i",
                    src_s.as_ref(),
                    "-vf",
                    vf_s.as_str(),
                    "-c:v",
                    "libx264",
                    "-profile:v",
                    "main",
                    "-level",
                    "3.1",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "28",
                    "-g",
                    "1",
                    "-keyint_min",
                    "1",
                    "-sc_threshold",
                    "0",
                    "-bf",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "96k",
                    "-movflags",
                    "frag_keyframe+empty_moov+default_base_moof",
                    "-f",
                    "mp4",
                    "-y",
                    partial_s.as_ref(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output()
        } else {
            Command::new(ffmpeg)
                .args([
                    "-i",
                    src_s.as_ref(),
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=48000:cl=stereo",
                    "-vf",
                    vf_s.as_str(),
                    "-c:v",
                    "libx264",
                    "-profile:v",
                    "main",
                    "-level",
                    "3.1",
                    "-preset",
                    "ultrafast",
                    "-crf",
                    "28",
                    "-g",
                    "1",
                    "-keyint_min",
                    "1",
                    "-sc_threshold",
                    "0",
                    "-bf",
                    "0",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-b:a",
                    "96k",
                    "-shortest",
                    "-movflags",
                    "frag_keyframe+empty_moov+default_base_moof",
                    "-f",
                    "mp4",
                    "-y",
                    partial_s.as_ref(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .output()
        }
    }
    .map_err(|e| format!("Could not run ffmpeg: {e}"))?;

    if !result.status.success() {
        let _ = fs::remove_file(&partial);
        let err = String::from_utf8_lossy(&result.stderr);
        return Err(format!("ffmpeg scrub proxy failed: {err}"));
    }
    fs::rename(&partial, dest).map_err(|e| format!("rename scrub proxy failed: {e}"))?;
    Ok(())
}

fn encode_audio_only(ffmpeg: &Path, src: &Path, dest: &Path, scrub: bool) -> Result<(), String> {
    let partial = partial_path(dest);
    let src_s = src.to_string_lossy();
    let partial_s = partial.to_string_lossy();
    let (w, h, crf, gop) = if scrub {
        (PROXY_SCRUB_W, PROXY_SCRUB_H, "28", "1".to_string())
    } else {
        (
            PROXY_PLAY_W,
            PROXY_PLAY_H,
            "23",
            PROXY_GOP.to_string(),
        )
    };
    // Black video + source audio so MSE always gets A/V.
    let vf = scale_filter(w, h);
    let color = format!("color=c=black:s={w}x{h}:r={PROXY_FPS}");
    let out = Command::new(ffmpeg)
        .args([
            "-f",
            "lavfi",
            "-i",
            color.as_str(),
            "-i",
            src_s.as_ref(),
            "-vf",
            vf.as_str(),
            "-c:v",
            "libx264",
            "-profile:v",
            "main",
            "-preset",
            "veryfast",
            "-crf",
            crf,
            "-g",
            gop.as_str(),
            "-keyint_min",
            gop.as_str(),
            "-sc_threshold",
            "0",
            "-bf",
            "0",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-b:a",
            "128k",
            "-shortest",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "-y",
            partial_s.as_ref(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = fs::remove_file(&partial);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffmpeg audio proxy failed: {err}"));
    }
    fs::rename(&partial, dest).map_err(|e| format!("rename audio proxy failed: {e}"))?;
    Ok(())
}

fn probe_has_audio(ffmpeg: &Path, src: &Path) -> bool {
    let src_s = src.to_string_lossy();
    let out = Command::new(ffmpeg)
        .args([
            "-i",
            src_s.as_ref(),
            "-vn",
            "-f",
            "null",
            "-",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output();
    match out {
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            err.contains("Audio:") || err.to_ascii_lowercase().contains("audio:")
        }
        Err(_) => false,
    }
}

fn proxies_fresh(play: &Path, scrub: &Path, hash: &str, expected: &str) -> bool {
    play.is_file() && scrub.is_file() && hash == expected
}

/// Ensure dual proxies exist for a creation. Idempotent; serializes per-id.
pub fn ensure_proxies(app: Option<&AppHandle>, creation_id: &str) -> Result<ProxyEnsureResult, String> {
    let gate = gate_for(creation_id);
    let _lock = gate.lock().unwrap_or_else(|e| e.into_inner());

    let paths = default_paths()?;
    fs::create_dir_all(proxy_dir(&paths)).map_err(|e| e.to_string())?;

    let creation = {
        let conn = ready_connection(&paths)?;
        get_creation_by_id(&conn, creation_id)?
            .ok_or_else(|| format!("Creation not found: {creation_id}"))?
    };

    let Some(local) = creation.local_path.as_deref() else {
        return Ok(ProxyEnsureResult {
            creation_id: creation_id.to_string(),
            status: "none".into(),
            play_path: None,
            scrub_path: None,
            hash: None,
        });
    };

    let src = path_under_root(&paths.root, local)?;
    let hash = content_hash(&src)?;
    let play = play_dest(&paths, creation_id);
    let scrub = scrub_dest(&paths, creation_id);

    if let (Some(p), Some(s), Some(h)) = (
        creation.proxy_play_path.as_deref(),
        creation.proxy_scrub_path.as_deref(),
        creation.proxy_hash.as_deref(),
    ) {
        let play_ok = Path::new(p).is_file() || play.is_file();
        let scrub_ok = Path::new(s).is_file() || scrub.is_file();
        if play_ok && scrub_ok && h == hash {
            let play_path = if play.is_file() {
                play.display().to_string()
            } else {
                p.to_string()
            };
            let scrub_path = if scrub.is_file() {
                scrub.display().to_string()
            } else {
                s.to_string()
            };
            return Ok(ProxyEnsureResult {
                creation_id: creation_id.to_string(),
                status: "ready".into(),
                play_path: Some(play_path),
                scrub_path: Some(scrub_path),
                hash: Some(hash),
            });
        }
    }

    if proxies_fresh(&play, &scrub, creation.proxy_hash.as_deref().unwrap_or(""), &hash) {
        let conn = ready_connection(&paths)?;
        set_proxy_fields(
            &conn,
            creation_id,
            Some(&play.display().to_string()),
            Some(&scrub.display().to_string()),
            "ready",
            Some(&hash),
        )?;
        return Ok(ProxyEnsureResult {
            creation_id: creation_id.to_string(),
            status: "ready".into(),
            play_path: Some(play.display().to_string()),
            scrub_path: Some(scrub.display().to_string()),
            hash: Some(hash),
        });
    }

    {
        let conn = ready_connection(&paths)?;
        set_proxy_fields(&conn, creation_id, None, None, "generating", Some(&hash))?;
    }
    if let Some(app) = app {
        let _ = app.emit(
            "library-proxy-progress",
            serde_json::json!({
                "creationId": creation_id,
                "status": "generating",
            }),
        );
    }

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| "FFmpeg is not available".to_string())?;
    let image = is_image(&creation, &src);
    let audio = is_audio(&creation, &src);

    let encode_result = if audio {
        encode_audio_only(&ffmpeg, &src, &play, false)
            .and_then(|_| encode_audio_only(&ffmpeg, &src, &scrub, true))
    } else {
        encode_playback_video(&ffmpeg, &src, &play, image)
            .and_then(|_| encode_scrub_video(&ffmpeg, &src, &scrub, image))
    };

    if let Err(e) = encode_result {
        let conn = ready_connection(&paths)?;
        set_proxy_fields(&conn, creation_id, None, None, "failed", Some(&hash))?;
        if let Some(app) = app {
            let _ = app.emit(
                "library-proxy-progress",
                serde_json::json!({
                    "creationId": creation_id,
                    "status": "failed",
                    "error": e,
                }),
            );
        }
        return Err(e);
    }

    let play_s = play.display().to_string();
    let scrub_s = scrub.display().to_string();
    {
        let conn = ready_connection(&paths)?;
        set_proxy_fields(
            &conn,
            creation_id,
            Some(&play_s),
            Some(&scrub_s),
            "ready",
            Some(&hash),
        )?;
        if let Ok(Some(updated)) = get_creation_by_id(&conn, creation_id) {
            if let Some(app) = app {
                let _ = app.emit("library-creation-updated", &updated);
            }
        }
    }

    let result = ProxyEnsureResult {
        creation_id: creation_id.to_string(),
        status: "ready".into(),
        play_path: Some(play_s),
        scrub_path: Some(scrub_s),
        hash: Some(hash),
    };
    if let Some(app) = app {
        let _ = app.emit("library-proxy-ready", &result);
    }
    Ok(result)
}

/// Look up proxy paths without generating.
pub fn proxy_paths_for(creation_id: &str) -> Result<Option<ProxyEnsureResult>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let Some(c) = get_creation_by_id(&conn, creation_id)? else {
        return Ok(None);
    };
    Ok(Some(ProxyEnsureResult {
        creation_id: creation_id.to_string(),
        status: c.proxy_status.unwrap_or_else(|| "none".into()),
        play_path: c.proxy_play_path,
        scrub_path: c.proxy_scrub_path,
        hash: c.proxy_hash,
    }))
}

#[tauri::command]
pub fn library_ensure_proxies(
    app: AppHandle,
    creation_id: String,
) -> Result<ProxyEnsureResult, String> {
    ensure_proxies(Some(&app), &creation_id)
}

#[tauri::command]
pub async fn library_ensure_proxies_async(
    app: AppHandle,
    creation_id: String,
) -> Result<ProxyEnsureResult, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_proxies(Some(&app), &creation_id))
        .await
        .map_err(|e| format!("proxy task failed: {e}"))?
}

/// Fire-and-forget proxy generation after import / download.
pub fn spawn_ensure_proxies(app: AppHandle, creation_id: String) {
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(move || ensure_proxies(Some(&app), &creation_id))
            .await;
    });
}
