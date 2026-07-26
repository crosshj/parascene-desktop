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

pub async fn get_json(token: &str, url: &str) -> Result<Value, String> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        sleep(Duration::from_millis(MIN_INTERVAL_MS)).await;
        let res = client()
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
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
        let body = res
            .text()
            .await
            .map_err(|e| format!("Read body failed: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("Replicate HTTP {status}: {body}"));
        }
        return serde_json::from_str(&body).map_err(|e| format!("Invalid JSON: {e}"));
    }
}
