use reqwest::Client;
use serde::Serialize;

fn client() -> Client {
    Client::new()
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
        .map_err(|e| format!("Could not reach {url} ({e})"))?;
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
        .map_err(|e| format!("Request failed: {e}"))?;
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
        .map_err(|e| format!("Could not reach {url} ({e})"))?;
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(result_from_response(status, &headers, body))
}
