//! Range-capable local media protocol for HTML `<video>` / `<audio>` playback.
//!
//! WebKit on macOS often corrupts mid-stream when serving large MP4s over
//! Tauri's built-in `asset://` protocol. A dedicated scheme that answers
//! HTTP Range requests keeps Publisher (and other) scrubbers stable.
//!
//! Audio probes without a Range header must get HTTP 200 (full body) — an
//! unsolicited 206 leaves WKWebView `<audio>` stuck buffering with `--:--`.

use http::{header::*, response::Builder as ResponseBuilder, status::StatusCode};
use http_range::HttpRange;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::library::paths::{account_root, resolve_paths};
use std::sync::Mutex;

/// Max bytes returned for a single range response.
/// WebKit needs generous ranged chunks for smooth mid-stream playback of large
/// scratch MP4s — tiny caps (≤512KiB) reintroduce the old Publisher choke where
/// the same file plays fine after Save. IO still runs off the UI thread.
const MAX_RANGE_LEN: u64 = 8 * 1024 * 1024;

static MEDIA_ROOTS: Mutex<Option<Vec<PathBuf>>> = Mutex::new(None);

pub fn refresh_media_roots() {
    if let Ok(mut slot) = MEDIA_ROOTS.lock() {
        *slot = None;
    }
}

fn allowed_roots() -> Result<Vec<PathBuf>, String> {
    let paths = resolve_paths(account_root()?);
    Ok(vec![
        paths.root.clone(),
        paths.library.clone(),
        paths.cache.clone(),
    ])
}

fn resolve_media_path(request_path: &str) -> Result<PathBuf, String> {
    let decoded = percent_encoding::percent_decode_str(request_path.trim_start_matches('/'))
        .decode_utf8()
        .map_err(|e| format!("Invalid media path encoding: {e}"))?
        .to_string();

    // convertFileSrc may produce `/Users/...` or `Users/...`.
    let candidate = if decoded.starts_with('/') {
        PathBuf::from(&decoded)
    } else if decoded.chars().nth(1) == Some(':') {
        // Windows drive path passed without leading slash.
        PathBuf::from(&decoded)
    } else {
        PathBuf::from(format!("/{decoded}"))
    };

    let file = candidate
        .canonicalize()
        .map_err(|e| format!("Media file missing or unreadable: {e}"))?;
    if !file.is_file() {
        return Err("Media path is not a file".into());
    }

    let mut slot = MEDIA_ROOTS
        .lock()
        .map_err(|_| "Media roots lock poisoned".to_string())?;
    if slot.is_none() {
        *slot = Some(
            allowed_roots()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|root| root.canonicalize().ok().or(Some(root)))
                .collect(),
        );
    }
    let roots = slot.as_ref().cloned().unwrap_or_default();
    if roots.is_empty() {
        return Err("Could not resolve Parascene media roots".into());
    }
    let allowed = roots.iter().any(|root| file.starts_with(root));
    if !allowed {
        return Err("Media path is outside the Parascene library".into());
    }
    Ok(file)
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("wav") => "audio/wav",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("ogg") | Some("oga") => "audio/ogg",
        Some("opus") => "audio/opus",
        Some("aiff") | Some("aif") => "audio/aiff",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn random_boundary() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("parascene_{nanos:x}")
}

pub fn media_response(
    request: http::Request<Vec<u8>>,
) -> Result<http::Response<Vec<u8>>, Box<dyn std::error::Error>> {
    let path = resolve_media_path(request.uri().path())?;
    let mut file = std::fs::File::open(&path)?;
    let len = {
        let old_pos = file.stream_position()?;
        let end = file.seek(SeekFrom::End(0))?;
        file.seek(SeekFrom::Start(old_pos))?;
        end
    };
    let mime = mime_for(&path);
    let mut resp = ResponseBuilder::new()
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-range, accept-ranges, content-length",
        );

    let http_response = if let Some(range_header) = request.headers().get("range") {
        let not_satisfiable = || {
            ResponseBuilder::new()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
        };

        let ranges = if let Ok(ranges) = HttpRange::parse(
            range_header.to_str().map_err(|_| "Invalid Range header")?,
            len,
        ) {
            ranges
                .iter()
                .map(|r| (r.start, r.start + r.length - 1))
                .collect::<Vec<_>>()
        } else {
            return Ok(not_satisfiable()?);
        };

        if ranges.len() == 1 {
            let &(start, mut end) = ranges.first().unwrap();
            if start >= len || end >= len || end < start {
                return Ok(not_satisfiable()?);
            }
            end = start + (end - start).min(len - start).min(MAX_RANGE_LEN - 1);
            let bytes_to_read = end + 1 - start;
            let mut buf = Vec::with_capacity(bytes_to_read as usize);
            file.seek(SeekFrom::Start(start))?;
            file.take(bytes_to_read).read_to_end(&mut buf)?;
            resp = resp
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(CONTENT_LENGTH, end + 1 - start)
                .status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        } else {
            let mut buf = Vec::new();
            let boundary = random_boundary();
            let boundary_sep = format!("\r\n--{boundary}\r\n");
            let boundary_closer = format!("\r\n--{boundary}--\r\n");
            resp = resp.header(
                CONTENT_TYPE,
                format!("multipart/byteranges; boundary={boundary}"),
            );

            for (start, mut end) in ranges {
                if start >= len || end >= len || end < start {
                    continue;
                }
                end = start + (end - start).min(len - start).min(MAX_RANGE_LEN - 1);
                buf.write_all(boundary_sep.as_bytes())?;
                buf.write_all(format!("{CONTENT_TYPE}: {mime}\r\n").as_bytes())?;
                buf.write_all(
                    format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n").as_bytes(),
                )?;
                buf.write_all(b"\r\n")?;
                let bytes_to_read = end + 1 - start;
                let mut local_buf = vec![0_u8; bytes_to_read as usize];
                file.seek(SeekFrom::Start(start))?;
                file.read_exact(&mut local_buf)?;
                buf.extend_from_slice(&local_buf);
            }
            buf.write_all(boundary_closer.as_bytes())?;
            resp.body(buf)
        }
    } else {
        // No Range header: HTTP requires 200 with the full entity (RFC 7233).
        // WebKit <audio> often probes without Range and hangs forever on an
        // unsolicited 206 (spinner + "--:--" in the library lightbox).
        // Large <video> is the exception — return a 206 prefix so WebKit
        // switches to Range requests instead of pulling an 80MB+ body at once.
        if mime.starts_with("video/") && len > MAX_RANGE_LEN {
            let end = MAX_RANGE_LEN - 1;
            let mut buf = Vec::with_capacity((end + 1) as usize);
            file.seek(SeekFrom::Start(0))?;
            file.take(end + 1).read_to_end(&mut buf)?;
            resp = resp
                .header(CONTENT_RANGE, format!("bytes 0-{end}/{len}"))
                .header(CONTENT_LENGTH, end + 1)
                .status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        } else {
            resp = resp.header(CONTENT_LENGTH, len);
            let mut buf = Vec::with_capacity(len as usize);
            file.read_to_end(&mut buf)?;
            resp.body(buf)
        }
    };

    http_response.map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::Request;

    fn fixture_mp3() -> PathBuf {
        let root = crate::library::paths::machine_root().expect("machine_root");
        crate::library::paths::set_account_root(Some(root.clone()));
        refresh_media_roots();
        let paths = resolve_paths(root);
        std::fs::create_dir_all(&paths.media).expect("media dir");
        let path = paths.media.join("_media_stream_test_fixture.mp3");
        // Minimal ID3-less MPEG frame payload is enough for protocol tests.
        std::fs::write(
            &path,
            b"ID3\x03\x00\x00\x00\x00\x00\x00fake-mp3-body-bytes!!",
        )
        .expect("write fixture");
        path
    }

    fn get(path: &Path) -> Request<Vec<u8>> {
        Request::builder()
            .uri(format!("https://media.localhost{}", path.to_string_lossy()))
            .body(Vec::new())
            .unwrap()
    }

    #[test]
    fn audio_without_range_returns_200_full_body() {
        let path = fixture_mp3();
        let len = std::fs::metadata(&path).unwrap().len();
        let response = media_response(get(&path)).expect("media_response");
        let _ = std::fs::remove_file(&path);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get(CONTENT_TYPE).unwrap(), "audio/mpeg");
        assert_eq!(
            response
                .headers()
                .get(CONTENT_LENGTH)
                .unwrap()
                .to_str()
                .unwrap()
                .parse::<u64>()
                .unwrap(),
            len
        );
        assert_eq!(response.body().len() as u64, len);
        assert!(response.headers().get(CONTENT_RANGE).is_none());
    }

    #[test]
    fn audio_with_range_returns_206() {
        let path = fixture_mp3();
        let request = Request::builder()
            .uri(format!("https://media.localhost{}", path.to_string_lossy()))
            .header("range", "bytes=0-1")
            .body(Vec::new())
            .unwrap();
        let response = media_response(request).expect("media_response");
        let _ = std::fs::remove_file(&path);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 2);
        assert!(response
            .headers()
            .get(CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("bytes 0-1/"));
    }

    #[test]
    fn convert_file_src_encoded_path_resolves() {
        let path = fixture_mp3();
        let len = std::fs::metadata(&path).unwrap().len();
        // Tauri convertFileSrc uses encodeURIComponent on the full path:
        // media://localhost/%2FUsers%2F...%2Ffile.mp3
        let encoded = path
            .to_string_lossy()
            .bytes()
            .flat_map(|b| match b {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'!'
                | b'~'
                | b'*'
                | b'\''
                | b'('
                | b')' => vec![b],
                _ => format!("%{b:02X}").into_bytes(),
            })
            .collect::<Vec<_>>();
        let encoded = String::from_utf8(encoded).unwrap();
        let request = Request::builder()
            .uri(format!("https://media.localhost/{encoded}"))
            .body(Vec::new())
            .unwrap();
        let response = media_response(request).expect("media_response");
        let _ = std::fs::remove_file(&path);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().len() as u64, len);
    }
}
