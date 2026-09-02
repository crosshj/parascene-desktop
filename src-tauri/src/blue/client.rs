use crate::blue::credentials::{BlueCredentials, BLUE_BASE_URL};
use reqwest::multipart;
use reqwest::Client;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::{sleep, timeout};

const MIN_INTERVAL_MS: u64 = 200;
const MAX_ATTEMPTS: u32 = 6;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop-Blue/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn download_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop-Blue/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

/// Polls must not reuse a held connection: Blue 202s can keep the body open
/// until the job finishes, and a later request on a fresh socket returns the file.
fn poll_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .pool_max_idle_per_host(0)
            .user_agent("ParasceneDesktop-Blue/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

const POLL_HEADERS_TIMEOUT: Duration = Duration::from_secs(40);
const POLL_JSON_BODY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_MEDIA_BODY_TIMEOUT: Duration = Duration::from_secs(600);

pub enum JobPoll {
    Pending,
    Saved(PathBuf),
    Json(Value),
}

fn is_media_content_type(ct: &str) -> bool {
    let ct = ct.to_ascii_lowercase();
    ct.starts_with("image/")
        || ct.starts_with("video/")
        || ct.starts_with("audio/")
        || ct.contains("octet-stream")
}

async fn write_response_body(res: reqwest::Response, dest: &Path) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir: {e}"))?;
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("Create file failed: {e}"))?;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download stream: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Write file: {e}"))?;
    }
    file.flush().await.map_err(|e| format!("Flush file: {e}"))?;
    Ok(())
}

/// One Blue job poll. Does not buffer a 202 body — that is what hung timeline
/// generate after Blue itself had already finished.
pub async fn poll_job(
    creds: &BlueCredentials,
    method: &str,
    job_id: &str,
    dest_dir: &Path,
) -> Result<JobPoll, String> {
    sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
    let url = absolute_url("/api");
    let body = serde_json::json!({
        "method": method,
        "args": { "job_id": job_id }
    });
    let send = apply_auth(
        poll_client()
            .post(&url)
            .header("Accept", "application/json, */*")
            .header("Content-Type", "application/json")
            .header("Connection", "close")
            .json(&body),
        creds,
    )
    .send();
    let res = match timeout(POLL_HEADERS_TIMEOUT, send).await {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => return Err(format!("Blue poll failed: {e}")),
        Err(_) => return Ok(JobPoll::Pending),
    };
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if status == 202 || status == 429 || status == 503 {
        let _ = timeout(Duration::from_millis(250), res.bytes()).await;
        return Ok(JobPoll::Pending);
    }
    if status == 404 {
        return Err(format!("Blue job not found: {job_id}"));
    }
    if status == 410 {
        let text = timeout(POLL_JSON_BODY_TIMEOUT, res.text())
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| {
                if text.trim().is_empty() {
                    "Output data removed (retention TTL expired).".into()
                } else {
                    text
                }
            });
        return Err(msg);
    }
    if !(200..300).contains(&status) {
        let text = timeout(POLL_JSON_BODY_TIMEOUT, res.text())
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        return Err(format!("Blue poll HTTP {status}: {text}"));
    }

    if is_media_content_type(&content_type) {
        let mut ext = ext_for_content_type(&content_type);
        if ext == "bin" {
            let m = method.to_ascii_lowercase();
            ext = if m.contains("video") {
                "mp4"
            } else if m.contains("audio") {
                "mp3"
            } else {
                "png"
            };
        }
        let dest = dest_dir.join(format!("output.{ext}"));
        timeout(POLL_MEDIA_BODY_TIMEOUT, write_response_body(res, &dest))
            .await
            .map_err(|_| "Blue output download timed out".to_string())?
            .map_err(|e| format!("Save Blue output: {e}"))?;
        return Ok(JobPoll::Saved(dest));
    }

    let bytes = timeout(POLL_JSON_BODY_TIMEOUT, res.bytes())
        .await
        .map_err(|_| "Blue poll JSON timed out".to_string())?
        .map_err(|e| format!("Read body failed: {e}"))?;
    let data: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid JSON: {e}"))?;
    Ok(JobPoll::Json(data))
}

fn apply_auth(req: reqwest::RequestBuilder, creds: &BlueCredentials) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {}", creds.token.trim()))
        .header("CF-Access-Client-Id", creds.cf_access_client_id.trim())
        .header(
            "CF-Access-Client-Secret",
            creds.cf_access_client_secret.trim(),
        )
}

fn absolute_url(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    if path.starts_with('/') {
        format!("{BLUE_BASE_URL}{path}")
    } else {
        format!("{BLUE_BASE_URL}/{path}")
    }
}

fn retry_after_secs(res: &reqwest::Response) -> u64 {
    res.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(2)
        .clamp(1, 120)
}

pub async fn get_json(creds: &BlueCredentials, path: &str) -> Result<Value, String> {
    let url = absolute_url(path);
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = apply_auth(
            client().get(&url).header("Accept", "application/json"),
            creds,
        )
        .send()
        .await
        .map_err(|e| format!("Blue GET failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                let body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Blue rate limited (HTTP {status}) after {attempt} attempts: {body}"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        let text = res
            .text()
            .await
            .map_err(|e| format!("Read body failed: {e}"))?;
        if status == 401 {
            return Err(
                "Unauthorized: Blue token or Cloudflare Access credentials invalid or missing."
                    .into(),
            );
        }
        if !(200..300).contains(&status) {
            return Err(format!("Blue HTTP {status}: {text}"));
        }
        return serde_json::from_str(&text).map_err(|e| format!("Invalid JSON: {e}"));
    }
}

pub async fn post_json(
    creds: &BlueCredentials,
    path: &str,
    body: &Value,
) -> Result<BlueHttpResponse, String> {
    let url = absolute_url(path);
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = apply_auth(
            client()
                .post(&url)
                .header("Accept", "application/json, */*")
                .header("Content-Type", "application/json")
                .json(body),
            creds,
        )
        .send()
        .await
        .map_err(|e| format!("Blue POST failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                let body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Blue rate limited (HTTP {status}) after {attempt} attempts: {body}"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        if status == 401 {
            return Err(
                "Unauthorized: Blue token or Cloudflare Access credentials invalid or missing."
                    .into(),
            );
        }
        let content_type = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = res
            .bytes()
            .await
            .map_err(|e| format!("Read body failed: {e}"))?;
        return Ok(BlueHttpResponse {
            status,
            content_type,
            bytes: bytes.to_vec(),
        });
    }
}

#[derive(Debug)]
pub struct BlueHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl BlueHttpResponse {
    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.bytes).map_err(|e| format!("Invalid JSON: {e}"))
    }

    pub fn is_binary_media(&self) -> bool {
        let ct = self.content_type.to_lowercase();
        ct.starts_with("image/")
            || ct.starts_with("video/")
            || ct.starts_with("audio/")
            || ct == "application/octet-stream"
    }
}

/// Multipart upload; returns relative `/api/files/…` URL from Blue.
pub async fn upload_file(creds: &BlueCredentials, path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("Blue upload source missing: {}", path.display()));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Read file failed: {e}"))?;
    if bytes.is_empty() {
        return Err(format!(
            "Blue upload source is empty (0 bytes): {}",
            path.display()
        ));
    }
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("upload.bin")
        .to_string();
    let mime = mime_for_upload_path(path, &bytes);
    let part = multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(mime)
        .map_err(|e| format!("multipart: {e}"))?;
    let form = multipart::Form::new().part("content", part);
    let url = absolute_url("/api/files");
    let res = apply_auth(client().post(&url), creds)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Blue upload failed: {e}"))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| format!("Read upload body failed: {e}"))?;
    if status == 401 {
        return Err(
            "Unauthorized: Blue token or Cloudflare Access credentials invalid or missing.".into(),
        );
    }
    if !(200..300).contains(&status) {
        return Err(format!("Blue upload HTTP {status}: {text}"));
    }
    let data: Value =
        serde_json::from_str(&text).map_err(|e| format!("Invalid upload JSON: {e}"))?;
    if let Some(u) = data
        .get("url")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        return Ok(u.to_string());
    }
    if let Some(name) = data
        .get("filename")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        return Ok(format!("/api/files/{}", urlencoding_simple(name)));
    }
    Err("Upload succeeded but no file URL was returned.".into())
}

fn mime_for_upload_path(path: &Path, bytes: &[u8]) -> &'static str {
    // Prefer magic bytes so a mislabeled extension does not confuse Blue/Comfy.
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return "image/jpeg";
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"fLaC" {
        return "audio/flac";
    }
    if bytes.len() >= 4 && &bytes[0..4] == b"OggS" {
        return "audio/ogg";
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return "audio/wav";
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

fn urlencoding_simple(s: &str) -> String {
    // Blue filenames are usually safe; encode only when needed.
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        s.to_string()
    } else {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
}

pub async fn download_to_path(
    creds: &BlueCredentials,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let absolute = absolute_url(url);
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = apply_auth(download_client().get(&absolute), creds)
            .send()
            .await
            .map_err(|e| format!("Blue download failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                return Err(format!("Blue download rate limited (HTTP {status})"));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        if !(200..300).contains(&status) {
            let text = res.text().await.unwrap_or_default();
            return Err(format!("Blue download HTTP {status}: {text}"));
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir: {e}"))?;
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(|e| format!("Create file failed: {e}"))?;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download stream: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write file: {e}"))?;
        }
        file.flush().await.map_err(|e| format!("Flush file: {e}"))?;
        return Ok(());
    }
}

pub fn ext_for_content_type(ct: &str) -> &'static str {
    let ct = ct.to_lowercase();
    if ct.contains("mp4") {
        "mp4"
    } else if ct.contains("webm") {
        "webm"
    } else if ct.contains("quicktime") || ct.contains("mov") {
        "mov"
    } else if ct.contains("png") {
        "png"
    } else if ct.contains("jpeg") || ct.contains("jpg") {
        "jpg"
    } else if ct.contains("webp") {
        "webp"
    } else if ct.contains("gif") {
        "gif"
    } else if ct.contains("wav") {
        "wav"
    } else if ct.contains("mpeg") || ct.contains("mp3") {
        "mp3"
    } else {
        "bin"
    }
}
