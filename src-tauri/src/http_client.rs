use reqwest::Client;
use serde::Serialize;

fn client() -> Client {
    Client::new()
}

#[derive(Clone, Serialize)]
pub struct HttpJsonResult {
    pub status: u16,
    pub body: String,
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
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpJsonResult { status, body })
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
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(HttpJsonResult { status, body })
}
