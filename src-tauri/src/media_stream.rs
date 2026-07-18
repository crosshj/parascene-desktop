//! Range-capable local media protocol for HTML `<video>` playback.
//!
//! WebKit on macOS often corrupts mid-stream when serving large MP4s over
//! Tauri's built-in `asset://` protocol. A dedicated scheme that answers
//! HTTP Range requests keeps Publisher (and other) scrubbers stable.

use http::{header::*, response::Builder as ResponseBuilder, status::StatusCode};
use http_range::HttpRange;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::library::paths::{default_root, resolve_paths};

/// Max bytes returned for a single range response.
const MAX_RANGE_LEN: u64 = 8 * 1024 * 1024;

fn allowed_roots() -> Result<Vec<PathBuf>, String> {
    let paths = resolve_paths(default_root()?);
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

    let roots = allowed_roots()?;
    let allowed = roots.iter().any(|root| {
        root.canonicalize()
            .map(|root| file.starts_with(root))
            .unwrap_or(false)
    });
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
        // Prefer ranged replies for video — full-body loads of 80MB+ MP4s are
        // what WebKit + asset:// tend to stumble on mid-playback.
        if mime.starts_with("video/") || mime.starts_with("audio/") {
            let end = (MAX_RANGE_LEN - 1).min(len.saturating_sub(1));
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
