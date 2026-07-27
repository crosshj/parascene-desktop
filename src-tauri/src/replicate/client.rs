use reqwest::Client;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::sleep;

const MIN_INTERVAL_MS: u64 = 350;
const MAX_ATTEMPTS: u32 = 6;

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .pool_idle_timeout(Duration::from_secs(90))
            .user_agent("ParasceneDesktop-Replicate/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn retry_after_secs(res: &reqwest::Response) -> u64 {
    res.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(2)
        .clamp(1, 120)
}

async fn send_json(
    method: reqwest::Method,
    token: &str,
    url: &str,
    body: Option<&Value>,
    extra_headers: &[(&str, &str)],
) -> Result<Value, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let mut req = client()
            .request(method.clone(), url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json");
        for (k, v) in extra_headers {
            req = req.header(*k, *v);
        }
        if let Some(b) = body {
            req = req
                .header("Content-Type", "application/json")
                .json(b);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("Replicate request failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                let body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Replicate rate limited (HTTP {status}) after {attempt} attempts: {body}"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        let text = res
            .text()
            .await
            .map_err(|e| format!("Read body failed: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("Replicate HTTP {status}: {text}"));
        }
        return serde_json::from_str(&text).map_err(|e| format!("Invalid JSON: {e}"));
    }
}

pub async fn get_json(token: &str, url: &str) -> Result<Value, String> {
    send_json(reqwest::Method::GET, token, url, None, &[]).await
}

pub async fn post_json(token: &str, url: &str, body: &Value) -> Result<Value, String> {
    send_json(reqwest::Method::POST, token, url, Some(body), &[]).await
}

/// Create a prediction; Prefer: wait asks Replicate to block briefly when possible.
pub async fn post_prediction(token: &str, body: &Value) -> Result<Value, String> {
    send_json(
        reqwest::Method::POST,
        token,
        "https://api.replicate.com/v1/predictions",
        Some(body),
        &[("Prefer", "wait=60")],
    )
    .await
}

/// Download a remote file (output URLs are typically public; auth is optional).
pub async fn download_to_path(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = client()
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                return Err(format!(
                    "Download rate limited (HTTP {status}) after {attempt} attempts"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        if !(200..300).contains(&status) {
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Download HTTP {status}: {body}"));
        }
        let bytes = res
            .bytes()
            .await
            .map_err(|e| format!("Download body failed: {e}"))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        std::fs::write(dest, &bytes).map_err(|e| format!("Write failed: {e}"))?;
        return Ok(());
    }
}
