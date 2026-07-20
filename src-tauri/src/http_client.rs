use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop/0.1")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

pub(crate) fn map_request_error(url: &str, err: reqwest::Error) -> String {
    let msg = err.to_string();
    if err.is_timeout() || msg.contains("timed out") || msg.contains("timeout") {
        return format!("Request timed out for {url}");
    }
    if err.is_connect()
        || msg.contains("error sending request")
        || msg.contains("connection")
        || msg.contains("dns")
    {
        return format!(
            "Couldn't reach Parascene ({url}). Check your network and try again."
        );
    }
    format!("Request failed for {url}: {msg}")
}

#[derive(Clone, Serialize)]
pub struct HttpJsonResult {
    pub status: u16,
    pub body: String,
    /// Seconds from Retry-After when present (429/503).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_sec: Option<u64>,
}

fn retry_after_from_headers(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let trimmed = raw.trim();
    if let Ok(secs) = trimmed.parse::<u64>() {
        return Some(secs.clamp(1, 120));
    }
    None
}

fn result_from_response(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    body: String,
) -> HttpJsonResult {
    HttpJsonResult {
        status,
        body,
        retry_after_sec: if status == 429 || status == 503 {
            retry_after_from_headers(headers)
        } else {
            None
        },
    }
}

#[tauri::command]
pub async fn http_post_json(url: String, body: String) -> Result<HttpJsonResult, String> {
    let res = client()
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| map_request_error(&url, e))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}

#[tauri::command]
pub async fn http_get_bearer(url: String, bearer: String) -> Result<HttpJsonResult, String> {
    let res = client()
        .get(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .send()
        .await
        .map_err(|e| map_request_error(&url, e))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}

#[tauri::command]
pub async fn http_delete_bearer(url: String, bearer: String) -> Result<HttpJsonResult, String> {
    let res = client()
        .delete(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .send()
        .await
        .map_err(|e| map_request_error(&url, e))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}

#[tauri::command]
pub async fn http_post_bearer(
    url: String,
    body: String,
    bearer: String,
) -> Result<HttpJsonResult, String> {
    let res = client()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {bearer}"))
        .body(body)
        .send()
        .await
        .map_err(|e| map_request_error(&url, e))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}

/// POST raw bytes with bearer (e.g. `POST /api/images/generic`).
#[tauri::command]
pub async fn http_post_bytes_bearer(
    url: String,
    body_base64: String,
    bearer: String,
    content_type: String,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<HttpJsonResult, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body_base64.trim())
        .map_err(|e| format!("Invalid base64 body: {e}"))?;
    let mut req = client()
        .post(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .header(
            "Content-Type",
            if content_type.trim().is_empty() {
                "application/octet-stream"
            } else {
                content_type.trim()
            },
        )
        .body(bytes);
    if let Some(headers) = extra_headers {
        for (k, v) in headers {
            req = req.header(k, v);
        }
    }
    let res = req
        .send()
        .await
        .map_err(|e| map_request_error(&url, e))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}
