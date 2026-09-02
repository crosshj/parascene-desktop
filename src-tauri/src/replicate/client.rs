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
            req = req.header("Content-Type", "application/json").json(b);
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

/// Unauthenticated HTML (Replicate playground API page). Do not send the API token.
pub async fn get_html(url: &str) -> Result<String, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = client()
            .get(url)
            .header("Accept", "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|e| format!("Replicate page request failed: {e}"))?;
        let status = res.status().as_u16();
        if status == 429 || status == 503 {
            let wait = retry_after_secs(&res);
            if attempt >= MAX_ATTEMPTS {
                let body = res.text().await.unwrap_or_default();
                return Err(format!(
                    "Replicate page rate limited (HTTP {status}) after {attempt} attempts: {body}"
                ));
            }
            sleep(Duration::from_secs(wait.saturating_mul(attempt as u64))).await;
            continue;
        }
        let text = res
            .text()
            .await
            .map_err(|e| format!("Read page failed: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("Replicate page HTTP {status}"));
        }
        return Ok(text);
    }
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

/// Download a remote file (prediction outputs, etc.).
/// Pass the Replicate API token when available — some delivery URLs require it,
/// and auth never hurts for `replicate.delivery` / `api.replicate.com`.
pub async fn download_to_path(
    url: &str,
    dest: &std::path::Path,
    token: Option<&str>,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;

        let mut req = download_client().get(url);
        if let Some(t) = token.map(str::trim).filter(|t| !t.is_empty()) {
            req = req.header("Authorization", format!("Bearer {t}"));
        }

        let res = match req.send().await {
            Ok(res) => res,
            Err(e) => {
                let err = format!("Download failed: {e}");
                if attempt >= MAX_ATTEMPTS {
                    return Err(err);
                }
                // Transient TLS / DNS / connection drops are common on CDN fetches.
                sleep(Duration::from_secs(u64::from(attempt).saturating_mul(2))).await;
                continue;
            }
        };

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
            let snippet: String = body.chars().take(240).collect();
            return Err(format!("Download HTTP {status}: {snippet}"));
        }

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        let tmp = dest.with_extension(format!(
            "{}.part",
            dest.extension()
                .and_then(|e| e.to_str())
                .unwrap_or("download")
        ));
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("Could not create {}: {e}", tmp.display()))?;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download body failed: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write failed: {e}"))?;
        }
        file.flush()
            .await
            .map_err(|e| format!("Flush failed: {e}"))?;
        drop(file);
        tokio::fs::rename(&tmp, dest)
            .await
            .map_err(|e| format!("Finalize download failed: {e}"))?;
        return Ok(());
    }
}

fn download_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(30))
            // Video outputs can be large; allow several minutes.
            .timeout(Duration::from_secs(10 * 60))
            .pool_idle_timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::limited(10))
            .user_agent("ParasceneDesktop-Replicate/1.0")
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}
