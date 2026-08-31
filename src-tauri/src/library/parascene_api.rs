//! Authenticated Parascene create/group HTTP helpers for the generation job worker.
//!
//! Mirrors the TypeScript SDK surface used by Lab / Director — not Labs-specific.

use crate::auth_store::{ensure_access_token, force_refresh_access_token};
use crate::http_client;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const API_BASE: &str = "https://www.parascene.com";

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop/0.1")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

async fn bearer_token() -> Result<String, String> {
    ensure_access_token().await
}

fn json_from_body(text: &str) -> Value {
    if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(text).unwrap_or_else(|_| json!({ "raw": text }))
    }
}

fn is_rate_limited(status: u16, value: &Value) -> bool {
    if status == 429 || status == 503 {
        return true;
    }
    let blob = value.to_string().to_ascii_lowercase();
    let limited = blob.contains("rate limit")
        || blob.contains("too many requests")
        || blob.contains("error code 1015");
    if status == 403 {
        // Cloudflare WAF/HTML blocks — not a missing token.
        return limited || blob.contains("<html") || blob.contains("cloudflare");
    }
    limited
}

struct RateGate {
    until: Option<Instant>,
    strikes: u32,
}

fn rate_gate() -> &'static Mutex<RateGate> {
    static GATE: OnceLock<Mutex<RateGate>> = OnceLock::new();
    GATE.get_or_init(|| {
        Mutex::new(RateGate {
            until: None,
            strikes: 0,
        })
    })
}

/// Remaining cooldown after a 429/403 storm, if any.
pub fn api_cooling_down() -> Option<Duration> {
    let gate = rate_gate().lock().ok()?;
    let until = gate.until?;
    until.checked_duration_since(Instant::now())
}

pub(crate) fn trip_rate_gate() {
    if let Ok(mut gate) = rate_gate().lock() {
        gate.strikes = gate.strikes.saturating_add(1).min(6);
        let shift = gate.strikes.saturating_sub(1).min(4);
        let secs = (15u64 << shift).min(300);
        gate.until = Some(Instant::now() + Duration::from_secs(secs));
        eprintln!(
            "[parascene-api] cooling down {secs}s after rate limit (strike {})",
            gate.strikes
        );
    }
}

fn note_api_ok() {
    if let Ok(mut gate) = rate_gate().lock() {
        gate.strikes = 0;
        gate.until = None;
    }
}

fn cooling_down_error() -> String {
    let secs = api_cooling_down().map(|d| d.as_secs().max(1)).unwrap_or(15);
    format!(
        "Rate limited (cooling down {secs}s). This computer is still blocked — not from this click."
    )
}

async fn request_json(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    request_json_limited(method, path, body).await
}

async fn request_json_limited(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{API_BASE}{path}")
    };

    let mut auth_retried = false;
    loop {
        if api_cooling_down().is_some() {
            return Err(cooling_down_error());
        }
        let token = bearer_token().await?;
        let mut req = client()
            .request(method.clone(), &url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json");
        if let Some(b) = body {
            req = req
                .header("Content-Type", "application/json")
                .body(b.to_string());
        }
        let res = req
            .send()
            .await
            .map_err(|e| http_client::map_request_error(&url, e))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        // Only 401 is "try a fresh token". Cloudflare 403 is a block — refreshing
        // and immediately retrying is what turns a wait-loop into a request storm.
        if status == 401 && !auth_retried {
            auth_retried = true;
            let _ = force_refresh_access_token().await;
            continue;
        }
        let value = json_from_body(&text);
        if is_rate_limited(status, &value) {
            trip_rate_gate();
            return Err(cooling_down_error());
        }
        if status < 400 {
            note_api_ok();
        }
        return Ok((status, value));
    }
}

async fn request_bytes_post(
    path: &str,
    body: &[u8],
    content_type: &str,
    extra_headers: &[(&str, &str)],
) -> Result<(u16, Value), String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{API_BASE}{path}")
    };

    let mut attempt = 0u8;
    loop {
        if api_cooling_down().is_some() {
            return Err(cooling_down_error());
        }
        attempt += 1;
        let token = bearer_token().await?;
        let mut req = client()
            .post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .header(
                "Content-Type",
                if content_type.trim().is_empty() {
                    "application/octet-stream"
                } else {
                    content_type.trim()
                },
            )
            .body(body.to_vec());
        for (k, v) in extra_headers {
            req = req.header(*k, *v);
        }
        let res = req
            .send()
            .await
            .map_err(|e| http_client::map_request_error(&url, e))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let value = json_from_body(&text);
        if status == 401 && attempt < 2 {
            let _ = force_refresh_access_token().await;
            continue;
        }
        if is_rate_limited(status, &value) {
            trip_rate_gate();
            return Err(cooling_down_error());
        }
        if status < 400 {
            note_api_ok();
        }
        return Ok((status, value));
    }
}

fn api_error(status: u16, value: &Value, fallback: &str) -> String {
    value
        .get("message")
        .and_then(|v| v.as_str())
        .or_else(|| value.get("error").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("{fallback} ({status})"))
}

pub fn creation_id(value: &Value) -> Option<String> {
    value.get("id").and_then(|v| match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

pub fn creation_status(value: &Value) -> String {
    let row = creation_row(value);
    row.get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase()
}

/// `GET /api/create/images/:id` sometimes wraps the row (`creation` / `image` / `data`).
pub fn creation_row(value: &Value) -> &Value {
    for key in ["creation", "image", "data"] {
        if let Some(inner) = value.get(key) {
            if inner.is_object()
                && (inner.get("id").is_some()
                    || inner.get("status").is_some()
                    || inner.get("url").is_some()
                    || inner.get("file_path").is_some())
            {
                return inner;
            }
        }
    }
    value
}

fn owned_creation_row(value: Value) -> Value {
    for key in ["creation", "image", "data"] {
        if let Some(inner) = value.get(key).cloned() {
            if inner.is_object()
                && (inner.get("id").is_some()
                    || inner.get("status").is_some()
                    || inner.get("url").is_some()
                    || inner.get("file_path").is_some())
            {
                return inner;
            }
        }
    }
    value
}

pub fn group_member_ids(value: &Value) -> Vec<String> {
    let group = value
        .get("meta")
        .and_then(|m| m.get("group"))
        .or_else(|| value.get("group"));
    let Some(group) = group else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(ids) = group.get("source_creation_ids").and_then(|v| v.as_array()) {
        for id in ids {
            let s = match id {
                Value::String(s) => s.trim().to_string(),
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            if s.is_empty() || !seen.insert(s.clone()) {
                continue;
            }
            out.push(s);
        }
    }
    if let Some(sources) = group.get("source_creations").and_then(|v| v.as_array()) {
        for source in sources {
            let id = match source {
                Value::Object(map) => map.get("id").and_then(|v| match v {
                    Value::String(s) => Some(s.trim().to_string()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                }),
                Value::String(s) => Some(s.trim().to_string()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
            let Some(s) = id else { continue };
            if s.is_empty() || !seen.insert(s.clone()) {
                continue;
            }
            out.push(s);
        }
    }
    out
}

/// Prefer the member Parascene marked as group cover artwork when present.
pub fn cover_source_id(value: &Value) -> Option<String> {
    let group = value
        .get("meta")
        .and_then(|m| m.get("group"))
        .or_else(|| value.get("group"))?;
    match group.get("cover_source_id")? {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn absolutize_media_path(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        return Some(t.to_string());
    }
    if let Some(rest) = t.strip_prefix("//") {
        return Some(format!("https:{rest}"));
    }
    if t.starts_with('/') {
        return Some(format!("{API_BASE}{t}"));
    }
    Some(format!("{API_BASE}/{t}"))
}

/// Prefer full media, then fit thumb, then square thumb (for i2v / still resolve).
/// Too broad for Generate wait — use `output_media_url`.
pub fn media_url(value: &Value) -> Option<String> {
    let value = creation_row(value);
    for key in [
        "url",
        "video_url",
        "fit_thumbnail_url",
        "thumbnail_url",
        "file_path",
    ] {
        if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(abs) = absolutize_media_path(s) {
                return Some(abs);
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitKind {
    Image,
    Video,
}

pub fn wait_kind_from_hints(
    media_type: Option<&str>,
    method: Option<&str>,
    intent: Option<&str>,
) -> WaitKind {
    let blob = format!(
        "{} {} {}",
        media_type.unwrap_or(""),
        method.unwrap_or(""),
        intent.unwrap_or("")
    )
    .to_ascii_lowercase();
    if blob.contains("video") {
        WaitKind::Video
    } else {
        WaitKind::Image
    }
}

pub fn url_looks_like_video(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    path.contains("/videos/")
        || path.contains("/video/")
        || path.ends_with(".mp4")
        || path.ends_with(".webm")
        || path.ends_with(".mov")
        || path.ends_with(".m4v")
}

pub fn url_looks_like_image(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    path.contains("/images/")
        || path.ends_with(".png")
        || path.ends_with(".jpg")
        || path.ends_with(".jpeg")
        || path.ends_with(".webp")
        || path.ends_with(".gif")
        || path.ends_with(".avif")
}

fn json_url_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .and_then(absolutize_media_path)
}

pub fn creation_is_terminal_status(value: &Value) -> bool {
    matches!(
        creation_status(value).as_str(),
        "failed" | "error" | "cancelled" | "canceled"
    )
}

/// Output URL of the expected type. Thumbs, posters, and input stills do not count.
pub fn output_media_url(value: &Value, kind: WaitKind) -> Option<String> {
    let row = creation_row(value);
    match kind {
        WaitKind::Video => {
            if let Some(url) = json_url_field(row, "video_url") {
                return Some(url);
            }
            for key in ["url", "file_path"] {
                if let Some(url) = json_url_field(row, key) {
                    if url_looks_like_video(&url) {
                        return Some(url);
                    }
                }
            }
            None
        }
        WaitKind::Image => {
            for key in ["url", "image_url", "file_path"] {
                if let Some(url) = json_url_field(row, key) {
                    if !url_looks_like_video(&url) {
                        return Some(url);
                    }
                }
            }
            None
        }
    }
}

pub fn wait_is_done(value: &Value, kind: WaitKind) -> bool {
    creation_is_terminal_status(value) || output_media_url(value, kind).is_some()
}

pub fn local_path_is_output(kind: WaitKind, local_path: Option<&str>, media_type: &str) -> bool {
    let Some(path) = local_path.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    match kind {
        WaitKind::Video => {
            url_looks_like_video(path)
                || (media_type.eq_ignore_ascii_case("video") && !url_looks_like_image(path))
        }
        WaitKind::Image => !url_looks_like_video(path),
    }
}

pub async fn list_my_creations(limit: u32, offset: u32) -> Result<(Vec<Value>, bool), String> {
    let lim = limit.clamp(1, 200);
    let off = offset;
    let path = format!("/api/create/images?limit={lim}&offset={off}");
    let (status, value) = request_json(reqwest::Method::GET, &path, None).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "list creations failed"));
    }
    let images = value
        .get("images")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let has_more = value
        .get("has_more")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Ok((images, has_more))
}

pub async fn upload_fit_thumbnail(id: &str, image_base64: &str) -> Result<Value, String> {
    let path = format!("/api/create/images/{}/fit-thumbnail", urlencoding_path(id));
    let body = json!({
        "image_base64": image_base64,
        "content_type": "image/jpeg",
    });
    let (status, value) = request_json(reqwest::Method::POST, &path, Some(&body)).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "upload fit thumb failed"));
    }
    Ok(value)
}

pub async fn repair_group_aspect(limit: u32) -> Result<Value, String> {
    let body = json!({ "limit": limit });
    let (status, value) = request_json(
        reqwest::Method::POST,
        "/api/create/images/repair-group-aspect",
        Some(&body),
    )
    .await?;
    if status >= 400 {
        return Err(api_error(status, &value, "repair group aspect failed"));
    }
    Ok(value)
}

pub async fn repair_fit_thumbnails(ids: &[String], force: bool) -> Result<Value, String> {
    let body = json!({
        "ids": ids,
        "limit": ids.len(),
        "force": force,
    });
    let (status, value) = request_json(
        reqwest::Method::POST,
        "/api/create/images/repair-fit-thumbnails",
        Some(&body),
    )
    .await?;
    if status >= 400 {
        return Err(api_error(status, &value, "repair fit thumbnails failed"));
    }
    Ok(value)
}

pub async fn get_creation(id: &str) -> Result<Value, String> {
    get_creation_once(id).await
}

/// Wait-loop GET. Rate-limit/403 trips a process-wide cooldown; do not retry here.
pub async fn get_creation_poll(id: &str) -> Result<Value, String> {
    get_creation_once(id).await
}

async fn get_creation_once(id: &str) -> Result<Value, String> {
    let path = format!("/api/create/images/{}", urlencoding_path(id));
    let (status, value) = request_json(reqwest::Method::GET, &path, None).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "get creation failed"));
    }
    Ok(owned_creation_row(value))
}

pub async fn delete_creation(id: &str) -> Result<(), String> {
    let path = format!("/api/create/images/{}", urlencoding_path(id));
    let (status, value) = request_json(reqwest::Method::DELETE, &path, None).await?;
    if status == 404 || status == 410 {
        return Ok(());
    }
    if status >= 400 {
        return Err(api_error(status, &value, "delete creation failed"));
    }
    Ok(())
}

pub async fn ungroup_creations(id: &str) -> Result<Vec<String>, String> {
    let path = format!("/api/create/images/{}/ungroup", urlencoding_path(id));
    let (status, value) = request_json(reqwest::Method::POST, &path, Some(&json!({}))).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "ungroup failed"));
    }
    Ok(value
        .get("restored_creation_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| match v {
                    Value::String(s) => {
                        let t = s.trim();
                        if t.is_empty() {
                            None
                        } else {
                            Some(t.to_string())
                        }
                    }
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default())
}

pub async fn get_library_folders() -> Result<Value, String> {
    let (status, value) = request_json(reqwest::Method::GET, "/api/library/folders", None).await?;
    if status == 501 {
        return Err("FOLDERS_UNAVAILABLE:Library folders are not available".into());
    }
    if status >= 400 {
        return Err(api_error(status, &value, "list library folders failed"));
    }
    Ok(value)
}

pub async fn mutate_library_folders(
    base_revision: u64,
    operations: &Value,
) -> Result<Value, String> {
    let body = json!({
        "base_revision": base_revision,
        "operations": operations,
    });
    let (status, value) = request_json(
        reqwest::Method::POST,
        "/api/library/folders/mutate",
        Some(&body),
    )
    .await?;
    if status == 409 {
        return Ok(json!({ "__conflict": true, "snapshot": value }));
    }
    if status == 501 {
        return Err("FOLDERS_UNAVAILABLE:Library folders are not available".into());
    }
    if status >= 400 {
        return Err(api_error(status, &value, "mutate library folders failed"));
    }
    Ok(value)
}

pub async fn create_media(opts: CreateOpts) -> Result<Value, String> {
    let mut body = json!({
        "server_id": opts.server_id,
        "method": opts.method,
        "args": opts.args,
        "creation_token": opts.creation_token,
    });
    if let Some(mutate_of_id) = opts.mutate_of_id {
        body["mutate_of_id"] = json!(mutate_of_id);
    }
    if let Some(group_id) = opts.group_id {
        body["group_id"] = json!(group_id);
    }
    let (status, value) = request_json(reqwest::Method::POST, "/api/create", Some(&body)).await?;
    if status == 402 {
        return Err(api_error(status, &value, "Insufficient credits"));
    }
    if status >= 400 {
        return Err(api_error(status, &value, "create failed"));
    }
    Ok(value)
}

pub async fn group_creations(
    ids: &[String],
    party_name: Option<&str>,
    meta: Option<&Value>,
) -> Result<Value, String> {
    let numeric: Vec<Value> = ids
        .iter()
        .filter_map(|id| id.parse::<i64>().ok().map(Value::from))
        .collect();
    if numeric.is_empty() {
        return Err("group_creations requires numeric ids".into());
    }
    let mut body = json!({ "ids": numeric });
    if let Some(name) = party_name.map(str::trim).filter(|s| !s.is_empty()) {
        body["party_name"] = json!(name);
    }
    if let Some(m) = meta {
        body["meta"] = m.clone();
    }
    let (status, value) = request_json(
        reqwest::Method::POST,
        "/api/create/images/group",
        Some(&body),
    )
    .await?;
    if status >= 400 {
        return Err(api_error(status, &value, "group failed"));
    }
    if let Some(grouped) = value.get("grouped_creation") {
        return Ok(grouped.clone());
    }
    if let Some(creation) = value.get("creation") {
        return Ok(creation.clone());
    }
    if let Some(id) = creation_id(&value) {
        return get_creation(&id).await;
    }
    Ok(value)
}

pub struct CreateOpts {
    pub server_id: i64,
    pub method: String,
    pub args: Value,
    pub creation_token: String,
    pub mutate_of_id: Option<i64>,
    pub group_id: Option<i64>,
}

pub async fn get_credits() -> Result<Value, String> {
    let (status, value) = request_json(reqwest::Method::GET, "/api/credits", None).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "credits failed"));
    }
    Ok(json!({
        "balance": value.get("balance").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "canClaim": value.get("canClaim").and_then(|v| v.as_bool())
            .or_else(|| value.get("can_claim").and_then(|v| v.as_bool()))
            .unwrap_or(false),
        "lastClaimDate": value.get("lastClaimDate").and_then(|v| v.as_str())
            .or_else(|| value.get("last_claim_date").and_then(|v| v.as_str())),
    }))
}

pub async fn delete_audio_clip(id: &str) -> Result<(), String> {
    let path = format!("/api/audio-clips/{}", urlencoding_path(id));
    let (status, value) = request_json(reqwest::Method::DELETE, &path, None).await?;
    if status == 404 || status == 410 {
        return Ok(());
    }
    if status >= 400 {
        return Err(api_error(status, &value, "delete audio clip failed"));
    }
    Ok(())
}

pub async fn record_audio_clip(
    body: &[u8],
    content_type: &str,
    title: Option<&str>,
    duration_sec: Option<f64>,
    source_type: Option<&str>,
) -> Result<Value, String> {
    let mut owned_headers: Vec<(String, String)> = Vec::new();
    if let Some(t) = title.map(str::trim).filter(|s| !s.is_empty()) {
        owned_headers.push(("X-audio-clip-title".into(), t.to_string()));
    }
    if let Some(sec) = duration_sec.filter(|s| s.is_finite() && *s > 0.0) {
        owned_headers.push(("X-audio-clip-duration-sec".into(), format!("{sec}")));
    }
    if let Some(st) = source_type.map(str::trim).filter(|s| !s.is_empty()) {
        owned_headers.push(("X-audio-clip-source-type".into(), st.to_string()));
    }
    let header_refs: Vec<(&str, &str)> = owned_headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let (status, value) =
        request_bytes_post("/api/audio-clips/record", body, content_type, &header_refs).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "audio clip upload failed"));
    }
    let item = value.get("item").unwrap_or(&value);
    let id = creation_id(item).ok_or_else(|| "audio clip upload returned no id".to_string())?;
    let audio_url = item
        .get("audio_url")
        .and_then(|v| v.as_str())
        .and_then(absolutize_media_path);
    Ok(json!({
        "id": id,
        "audioUrl": audio_url,
        "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "durationSec": item.get("duration_sec").and_then(|v| v.as_f64()),
    }))
}

pub async fn upload_generic_image(
    body: &[u8],
    content_type: &str,
    filename: &str,
) -> Result<Value, String> {
    let name = if filename.trim().is_empty() {
        "lab-seed.png"
    } else {
        filename.trim()
    };
    let headers = [("X-upload-kind", "generic"), ("X-upload-name", name)];
    let (status, value) =
        request_bytes_post("/api/images/generic", body, content_type, &headers).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "upload failed"));
    }
    let url = value
        .get("url")
        .and_then(|v| v.as_str())
        .and_then(absolutize_media_path)
        .ok_or_else(|| "upload succeeded but no url returned".to_string())?;
    Ok(json!({
        "url": url,
        "key": value.get("key").and_then(|v| v.as_str()),
    }))
}

/// Mint Parascene ephemeral Blue CDN storage, PUT the jpeg, return still_url.
pub async fn upload_ephemeral_still(
    body: &[u8],
    content_type: &str,
    filename: &str,
) -> Result<Value, String> {
    let name = if filename.trim().is_empty() {
        "frame.jpg"
    } else {
        filename.trim()
    };
    let ct = if content_type.trim().is_empty() {
        "image/jpeg"
    } else {
        content_type.trim()
    };
    let start_body = json!({
        "filename": name,
        "content_type": ct,
    });
    let (start_status, start) = request_json(
        reqwest::Method::POST,
        "/api/create/ephemeral-still/start",
        Some(&start_body),
    )
    .await?;
    if start_status >= 400 {
        return Err(api_error(start_status, &start, "ephemeral still start failed"));
    }
    let upload_url = start
        .get("upload_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ephemeral still start returned no upload_url".to_string())?;
    let ticket = start
        .get("ticket")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "ephemeral still start returned no ticket".to_string())?;

    let put = client()
        .put(upload_url)
        .header("Content-Type", ct)
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| format!("ephemeral still PUT failed: {e}"))?;
    let put_status = put.status().as_u16();
    if put_status >= 400 {
        let text = put.text().await.unwrap_or_default();
        return Err(format!("ephemeral still PUT failed ({put_status}): {text}"));
    }

    let fin_body = json!({ "ticket": ticket });
    let (fin_status, fin) = request_json(
        reqwest::Method::POST,
        "/api/create/ephemeral-still/finalize",
        Some(&fin_body),
    )
    .await?;
    if fin_status >= 400 {
        return Err(api_error(fin_status, &fin, "ephemeral still finalize failed"));
    }
    let still_url = fin
        .get("still_url")
        .and_then(|v| v.as_str())
        .and_then(absolutize_media_path)
        .ok_or_else(|| "ephemeral still finalize returned no still_url".to_string())?;
    Ok(json!({
        "stillUrl": still_url,
        "expiresAt": fin.get("expires_at").and_then(|v| v.as_str()),
    }))
}

fn urlencoding_path(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unwraps_nested_creation_rows() {
        let wrapped = json!({
            "creation": {
                "id": 26045,
                "status": "creating",
                "url": "https://www.parascene.com/x.png",
            }
        });
        assert_eq!(creation_row(&wrapped)["id"], 26045);
    }

    #[test]
    fn wait_image_ignores_thumbs_and_video() {
        assert!(!wait_is_done(
            &json!({
                "id": 1,
                "status": "creating",
                "thumbnail_url": "https://www.parascene.com/t.jpg",
                "fit_thumbnail_url": "https://www.parascene.com/fit.jpg",
            }),
            WaitKind::Image,
        ));
        assert!(wait_is_done(
            &json!({
                "id": 1,
                "status": "creating",
                "url": "https://www.parascene.com/api/images/created/done.png",
            }),
            WaitKind::Image,
        ));
        assert!(!wait_is_done(
            &json!({
                "id": 1,
                "status": "creating",
                "url": "https://www.parascene.com/api/videos/created/video/x.mp4",
            }),
            WaitKind::Image,
        ));
    }

    #[test]
    fn wait_video_requires_video_output_not_poster() {
        assert!(!wait_is_done(
            &json!({
                "id": 2,
                "status": "creating",
                "url": "https://www.parascene.com/api/images/created/still.png",
                "thumbnail_url": "https://www.parascene.com/t.jpg",
                "file_path": "/api/images/created/still.png",
            }),
            WaitKind::Video,
        ));
        assert!(wait_is_done(
            &json!({
                "id": 2,
                "status": "creating",
                "video_url": "https://www.parascene.com/api/videos/created/video/x.mp4",
            }),
            WaitKind::Video,
        ));
        assert!(wait_is_done(
            &json!({
                "id": 2,
                "status": "complete",
                "url": "/api/videos/created/video/x.mp4",
            }),
            WaitKind::Video,
        ));
        assert!(wait_is_done(
            &json!({ "id": 2, "status": "failed" }),
            WaitKind::Video,
        ));
        assert!(!wait_is_done(
            &json!({ "id": 2, "status": "" }),
            WaitKind::Video,
        ));
    }

    #[test]
    fn local_poster_is_not_video_output() {
        assert!(!local_path_is_output(
            WaitKind::Video,
            Some("/tmp/26053.jpg"),
            "video",
        ));
        assert!(local_path_is_output(
            WaitKind::Video,
            Some("/tmp/26053.mp4"),
            "video",
        ));
        assert!(local_path_is_output(
            WaitKind::Image,
            Some("/tmp/26045.png"),
            "image",
        ));
        assert!(!local_path_is_output(WaitKind::Image, None, "image"));
    }

    #[test]
    fn cloudflare_403_counts_as_rate_limit_not_auth() {
        assert!(is_rate_limited(
            403,
            &json!({ "error": "Rate limit exceeded" }),
        ));
        assert!(is_rate_limited(
            403,
            &json!({ "raw": "<html>cloudflare error code 1015</html>" }),
        ));
        assert!(!is_rate_limited(403, &json!({ "error": "forbidden" }),));
        assert!(is_rate_limited(429, &json!({})));
    }
}
