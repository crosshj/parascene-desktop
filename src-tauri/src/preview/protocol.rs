//! Custom `preview://` protocol serving session fragment bytes for MSE fetch.

use crate::preview::session::resolve_session_file;
use http::{header::*, response::Builder as ResponseBuilder, status::StatusCode};
use http_range::HttpRange;
use std::io::{Read, Seek, SeekFrom, Write};

const MAX_RANGE_LEN: u64 = 8 * 1024 * 1024;

fn mime_for(name: &str) -> &'static str {
    if name.ends_with(".m4s") || name.ends_with(".mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}

/// URI shapes:
/// - `preview://localhost/{sessionId}/{file}`
/// - `preview://{sessionId}/{file}`
pub fn preview_response(
    request: http::Request<Vec<u8>>,
) -> Result<http::Response<Vec<u8>>, Box<dyn std::error::Error>> {
    let path = request.uri().path().trim_start_matches('/');
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    // host may be in authority; path is /session/file or /localhost/session/file
    let (session_id, file) = match parts.as_slice() {
        [sid, file] => (*sid, *file),
        ["localhost", sid, file] => (*sid, *file),
        _ => return Err("Invalid preview URI".into()),
    };

    let file_path = resolve_session_file(session_id, file)?;
    if !file_path.is_file() {
        let body = b"Not found".to_vec();
        return Ok(ResponseBuilder::new()
            .status(StatusCode::NOT_FOUND)
            .header(CONTENT_TYPE, "text/plain")
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(body)?);
    }

    let mut file_handle = std::fs::File::open(&file_path)?;
    let len = {
        let old = file_handle.stream_position()?;
        let end = file_handle.seek(SeekFrom::End(0))?;
        file_handle.seek(SeekFrom::Start(old))?;
        end
    };
    let mime = mime_for(file);
    let mut resp = ResponseBuilder::new()
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-range, accept-ranges, content-length, content-type",
        )
        .header(CACHE_CONTROL, "no-store");

    if request.method() == http::Method::OPTIONS {
        return Ok(resp.status(StatusCode::NO_CONTENT).body(Vec::new())?);
    }

    let http_response = if let Some(range_header) = request.headers().get("range") {
        let ranges = HttpRange::parse(
            range_header.to_str().map_err(|_| "Invalid Range")?,
            len,
        )
        .map_err(|_| "Invalid Range")?;
        if ranges.len() == 1 {
            let r = &ranges[0];
            let start = r.start;
            let mut end = r.start + r.length - 1;
            end = start + (end - start).min(len - start).min(MAX_RANGE_LEN - 1);
            let bytes_to_read = end + 1 - start;
            let mut buf = Vec::with_capacity(bytes_to_read as usize);
            file_handle.seek(SeekFrom::Start(start))?;
            file_handle.take(bytes_to_read).read_to_end(&mut buf)?;
            resp = resp
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(CONTENT_LENGTH, end + 1 - start)
                .status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        } else {
            let mut buf = Vec::new();
            let boundary = "parascene_preview";
            resp = resp.header(
                CONTENT_TYPE,
                format!("multipart/byteranges; boundary={boundary}"),
            );
            for r in ranges {
                let start = r.start;
                let mut end = r.start + r.length - 1;
                end = start + (end - start).min(len - start).min(MAX_RANGE_LEN - 1);
                let _ = write!(buf, "\r\n--{boundary}\r\n");
                let _ = write!(buf, "{CONTENT_TYPE}: {mime}\r\n");
                let _ = write!(buf, "{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n\r\n");
                let bytes_to_read = end + 1 - start;
                let mut local = vec![0_u8; bytes_to_read as usize];
                file_handle.seek(SeekFrom::Start(start))?;
                file_handle.read_exact(&mut local)?;
                buf.extend_from_slice(&local);
            }
            let _ = write!(buf, "\r\n--{boundary}--\r\n");
            resp.body(buf)
        }
    } else {
        resp = resp.header(CONTENT_LENGTH, len);
        let mut buf = Vec::with_capacity(len as usize);
        file_handle.read_to_end(&mut buf)?;
        resp.body(buf)
    };

    Ok(http_response?)
}
