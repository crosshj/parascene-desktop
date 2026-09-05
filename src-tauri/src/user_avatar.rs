//! Download + validate the signed-in user's OAuth avatar into Cache/avatars.
//!
//! Catalog sync (and login) call this so chrome never points `<img>` at an
//! unverified remote URL. Invalid / empty / HTML responses are rejected.

use crate::auth_store;
use crate::library::paths::{account_root, ensure_directories, resolve_paths};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

const AVATAR_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_IMAGE_BYTES: u64 = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureUserAvatarResult {
    /// True when there is no picture URL, or a verified local file is ready.
    pub ok: bool,
    /// Absolute path to a verified image under Cache/avatars, when available.
    pub local_path: Option<String>,
    /// Why download/validation failed (ok=false), or why there is no avatar.
    pub reason: Option<String>,
}

fn avatar_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(AVATAR_TIMEOUT)
            .user_agent("ParasceneDesktop/0.1 (Macintosh; Tauri)")
            .build()
            .expect("avatar reqwest client")
    })
}

fn safe_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "user".into()
    } else {
        s
    }
}

fn url_content_token(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

/// Detect image kind from magic bytes. Returns a file extension without the dot.
pub(crate) fn image_ext_from_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("jpg");
    }
    if bytes.len() >= 8 && bytes[0..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some("png");
    }
    if bytes.len() >= 6 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some("gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    None
}

fn looks_like_html(bytes: &[u8]) -> bool {
    let head = bytes
        .iter()
        .take(64)
        .map(|b| b.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let s = String::from_utf8_lossy(&head);
    let t = s.trim_start();
    t.starts_with("<!doctype") || t.starts_with("<html") || t.starts_with("<head")
}

fn extension_hint(url: &str, content_type: Option<&str>) -> String {
    if let Some(ct) = content_type {
        let ct = ct
            .split(';')
            .next()
            .unwrap_or(ct)
            .trim()
            .to_ascii_lowercase();
        match ct.as_str() {
            "image/jpeg" | "image/jpg" => return "jpg".into(),
            "image/png" => return "png".into(),
            "image/webp" => return "webp".into(),
            "image/gif" => return "gif".into(),
            _ => {}
        }
    }
    let path_part = url.split('?').next().unwrap_or(url);
    if let Some(name) = path_part.rsplit('/').next() {
        if let Some((_, ext)) = name.rsplit_once('.') {
            let e = ext.to_ascii_lowercase();
            if matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp" | "gif") {
                return if e == "jpeg" { "jpg".into() } else { e };
            }
        }
    }
    "img".into()
}

fn avatars_dir() -> Result<PathBuf, String> {
    let paths = resolve_paths(account_root()?);
    ensure_directories(&paths)?;
    let dir = paths.cache.join("avatars");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn dest_path(user_id: &str, picture_url: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = avatars_dir()?;
    Ok(dir.join(format!(
        "{}_{}.{}",
        safe_id(user_id),
        url_content_token(picture_url),
        ext
    )))
}

fn validate_avatar_file(path: &Path) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("Avatar stat failed: {e}"))?;
    if !meta.is_file() {
        return Err("Avatar path is not a file".into());
    }
    if meta.len() < MIN_IMAGE_BYTES {
        return Err(format!("Avatar file too small ({} bytes)", meta.len()));
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("Avatar open failed: {e}"))?;
    use std::io::Read;
    let mut header = [0u8; 16];
    let n = file
        .read(&mut header)
        .map_err(|e| format!("Avatar read failed: {e}"))?;
    if looks_like_html(&header[..n]) {
        return Err("Avatar response looks like HTML, not an image".into());
    }
    if image_ext_from_magic(&header[..n]).is_none() {
        return Err("Avatar file is not a recognized image".into());
    }
    Ok(())
}

/// Prefer an existing valid cache file for this user+url (any recognized ext).
fn find_existing_valid(user_id: &str, picture_url: &str) -> Option<PathBuf> {
    let Ok(dir) = avatars_dir() else {
        return None;
    };
    let stem = format!("{}_{}", safe_id(user_id), url_content_token(picture_url));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if name != stem {
            continue;
        }
        if validate_avatar_file(&path).is_ok() {
            return Some(path);
        }
        let _ = std::fs::remove_file(&path);
    }
    None
}

async fn download_avatar_bytes(url: &str) -> Result<(Vec<u8>, Option<String>), String> {
    let mut req = avatar_client().get(url);
    if let Ok(token) = auth_store::ensure_access_token().await {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("Avatar download failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Avatar download HTTP {}", status.as_u16()));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if let Some(ct) = content_type.as_deref() {
        let ct_l = ct.to_ascii_lowercase();
        if ct_l.contains("text/html") || ct_l.contains("application/json") {
            return Err(format!("Avatar content-type is not an image ({ct})"));
        }
    }
    let mut bytes = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Avatar stream error: {e}"))?;
        bytes.extend_from_slice(&chunk);
        // Hard cap — avatars should be small; huge payloads are suspicious.
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Avatar download exceeded 8MB".into());
        }
    }
    Ok((bytes, content_type))
}

fn write_avatar_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let tmp = dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("img")
    ));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|e| format!("Could not create {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("Avatar write failed: {e}"))?;
        file.flush()
            .map_err(|e| format!("Avatar flush failed: {e}"))?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Avatar finalize failed: {e}")
    })?;
    Ok(())
}

/// Ensure the user's avatar is on disk and is a real image.
///
/// - Empty / missing `picture_url` → `ok: true`, no path (use letter placeholder).
/// - Valid cache hit or successful download → `ok: true` + `local_path`.
/// - Failed download / not an image → `ok: false`, no path (UI must placeholder).
#[tauri::command]
pub async fn auth_ensure_user_avatar(
    user_id: String,
    picture_url: Option<String>,
) -> Result<EnsureUserAvatarResult, String> {
    let user_id = user_id.trim().to_string();
    if user_id.is_empty() {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some("Missing user id".into()),
        });
    }

    let picture = picture_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let Some(picture) = picture else {
        return Ok(EnsureUserAvatarResult {
            ok: true,
            local_path: None,
            reason: Some("No avatar URL".into()),
        });
    };

    if !(picture.starts_with("https://") || picture.starts_with("http://")) {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some("Avatar URL must be http(s)".into()),
        });
    }

    if let Some(existing) = find_existing_valid(&user_id, &picture) {
        return Ok(EnsureUserAvatarResult {
            ok: true,
            local_path: Some(existing.display().to_string()),
            reason: None,
        });
    }

    let (bytes, content_type) = match download_avatar_bytes(&picture).await {
        Ok(v) => v,
        Err(err) => {
            return Ok(EnsureUserAvatarResult {
                ok: false,
                local_path: None,
                reason: Some(err),
            });
        }
    };

    if (bytes.len() as u64) < MIN_IMAGE_BYTES {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some(format!("Avatar body too small ({} bytes)", bytes.len())),
        });
    }
    if looks_like_html(&bytes) {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some("Avatar body looks like HTML".into()),
        });
    }
    let Some(magic_ext) = image_ext_from_magic(&bytes) else {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some("Avatar body is not a recognized image".into()),
        });
    };

    let hint = extension_hint(&picture, content_type.as_deref());
    let ext = if hint == magic_ext || hint == "img" {
        magic_ext
    } else {
        // Prefer sniffed type over Content-Type / URL extension.
        magic_ext
    };

    let dest = dest_path(&user_id, &picture, ext)?;
    if let Err(err) = write_avatar_atomic(&dest, &bytes) {
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some(err),
        });
    }
    if let Err(err) = validate_avatar_file(&dest) {
        let _ = std::fs::remove_file(&dest);
        return Ok(EnsureUserAvatarResult {
            ok: false,
            local_path: None,
            reason: Some(err),
        });
    }

    Ok(EnsureUserAvatarResult {
        ok: true,
        local_path: Some(dest.display().to_string()),
        reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_image_magic() {
        assert_eq!(image_ext_from_magic(&[0xff, 0xd8, 0xff, 0xe0]), Some("jpg"));
        assert_eq!(
            image_ext_from_magic(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("png")
        );
        assert_eq!(image_ext_from_magic(b"GIF89a............"), Some("gif"));
        let mut webp = b"RIFF....WEBP".to_vec();
        webp[4] = 0;
        assert_eq!(image_ext_from_magic(&webp), Some("webp"));
        assert_eq!(image_ext_from_magic(b"<!DOCTYPE html>"), None);
        assert_eq!(image_ext_from_magic(b"{}"), None);
    }

    #[test]
    fn detects_html_payloads() {
        assert!(looks_like_html(b"<!DOCTYPE html><html>"));
        assert!(looks_like_html(b"  <html lang=en>"));
        assert!(!looks_like_html(&[0xff, 0xd8, 0xff, 0xe0]));
    }
}
