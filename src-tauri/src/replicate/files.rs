//! Upload local files to Replicate for prediction URI inputs.
//! Images prefer data URIs (inline bytes) so external models like Vidu never
//! have to fetch an authenticated Files API URL. Other media still use the
//! 256 KiB data-URI cutoff, then POST /v1/files.

use base64::Engine;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

/// Replicate docs default for generic data URIs.
const DATA_URI_MAX_BYTES: u64 = 256 * 1024;
/// Image stills (start_image etc.) — keep inline so predictors always see bytes.
const IMAGE_DATA_URI_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Official client upload limit for the Files API.
const FILES_API_MAX_BYTES: u64 = 100 * 1024 * 1024;

const MIN_INTERVAL_MS: u64 = 350;
const MAX_ATTEMPTS: u32 = 6;

fn upload_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // Large media uploads can take several minutes on slow links.
            .timeout(Duration::from_secs(10 * 60))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop-Replicate/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn retry_after_secs(res: &reqwest::Response) -> u64 {
    res.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(2)
        .clamp(1, 120)
}

pub fn mime_from_path(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" | "aac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "opus" => "audio/opus",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "m4v" => "video/x-m4v",
        _ => "application/octet-stream",
    }
}

fn filename_for(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s.len() <= 255)
        .unwrap_or_else(|| "upload.bin".into())
}

/// Resolve a local file into a URI Replicate can fetch (data URI or Files API `urls.get`).
pub async fn resolve_local_file_uri(token: &str, path: &str) -> Result<String, String> {
    let p = PathBuf::from(path);
    if !p.is_file() {
        return Err(format!("Local file not found: {path}"));
    }
    let meta = std::fs::metadata(&p).map_err(|e| format!("Could not read {}: {e}", p.display()))?;
    let size = meta.len();
    if size == 0 {
        return Err(format!("File is empty: {}", p.display()));
    }
    if size > FILES_API_MAX_BYTES {
        return Err(format!(
            "File is too large for Replicate upload ({} MiB). Maximum is {} MiB. Host it yourself and pass an HTTPS URL, or use a smaller file.",
            (size + 1024 * 1024 - 1) / (1024 * 1024),
            FILES_API_MAX_BYTES / (1024 * 1024)
        ));
    }

    let mime = mime_from_path(&p);
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("Could not read {}: {e}", p.display()))?;

    let data_uri_limit = if mime.starts_with("image/") {
        IMAGE_DATA_URI_MAX_BYTES
    } else {
        DATA_URI_MAX_BYTES
    };
    if size <= data_uri_limit {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(format!("data:{mime};base64,{b64}"));
    }

    upload_file_bytes(token, &bytes, &filename_for(&p), mime).await
}

async fn upload_file_bytes(
    token: &str,
    bytes: &[u8],
    filename: &str,
    mime: &str,
) -> Result<String, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;

        let part = Part::bytes(bytes.to_vec())
            .file_name(filename.to_string())
            .mime_str(mime)
            .map_err(|e| format!("Invalid MIME type {mime}: {e}"))?;
        let form = Form::new().part("content", part);

        let res = upload_client()
            .post("https://api.replicate.com/v1/files")
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("Replicate file upload failed: {e}"))?;

        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                let body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Replicate file upload rate limited (HTTP {status}) after {attempt} attempts: {body}"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }

        let text = res
            .text()
            .await
            .map_err(|e| format!("Read upload response failed: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("Replicate file upload HTTP {status}: {text}"));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Invalid upload JSON: {e}"))?;
        let uri = value
            .pointer("/urls/get")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                format!("Replicate file upload response missing urls.get: {text}")
            })?;
        return Ok(uri);
    }
}

/// OS file picker for Replicate URI inputs. Returns `None` if the user cancels.
pub fn pick_local_file(kind: &str) -> Result<Option<String>, String> {
    let kind = kind.trim().to_ascii_lowercase();
    let mut dialog = rfd::FileDialog::new();
    match kind.as_str() {
        "image" => {
            dialog = dialog
                .set_title("Choose image for Replicate")
                .add_filter(
                    "Images",
                    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
                );
        }
        "audio" => {
            dialog = dialog
                .set_title("Choose audio for Replicate")
                .add_filter(
                    "Audio",
                    &["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "webm"],
                );
        }
        "video" => {
            dialog = dialog
                .set_title("Choose video for Replicate")
                .add_filter(
                    "Video",
                    &["mp4", "mov", "webm", "mkv", "avi", "m4v"],
                );
        }
        _ => {
            dialog = dialog
                .set_title("Choose file for Replicate")
                .add_filter(
                    "Media",
                    &[
                        "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "mp3", "wav",
                        "m4a", "aac", "ogg", "flac", "opus", "mp4", "mov", "webm", "mkv", "avi",
                        "m4v",
                    ],
                )
                .add_filter("All files", &["*"]);
        }
    }
    Ok(dialog.pick_file().map(|p| p.to_string_lossy().to_string()))
}
