//! Authenticated Parascene create/group HTTP helpers for the generation job worker.
//!
//! Mirrors the TypeScript SDK surface used by Lab / Director — not Labs-specific.

use crate::auth_store::{ensure_access_token, force_refresh_access_token};
use crate::http_client;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;

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

async fn request_json(
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let url = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{API_BASE}{path}")
    };

    let mut attempt = 0u8;
    loop {
        attempt += 1;
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
        if (status == 401 || status == 403) && attempt < 2 {
            let _ = force_refresh_access_token().await;
            continue;
        }
        let value = if text.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }))
        };
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
    value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase()
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
pub fn media_url(value: &Value) -> Option<String> {
    for key in ["url", "video_url", "fit_thumbnail_url", "thumbnail_url", "file_path"] {
        if let Some(s) = value.get(key).and_then(|v| v.as_str()) {
            if let Some(abs) = absolutize_media_path(s) {
                return Some(abs);
            }
        }
    }
    None
}

pub async fn get_creation(id: &str) -> Result<Value, String> {
    let path = format!("/api/create/images/{}", urlencoding_path(id));
    let (status, value) = request_json(reqwest::Method::GET, &path, None).await?;
    if status >= 400 {
        return Err(api_error(status, &value, "get creation failed"));
    }
    Ok(value)
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
    let (status, value) =
        request_json(reqwest::Method::POST, "/api/create/images/group", Some(&body)).await?;
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

fn urlencoding_path(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u8),
        })
        .collect()
}
