//! Session secret storage + single-flight OAuth refresh.
//!
//! - **Release builds**: macOS Keychain (`keyring`).
//! - **Debug builds** (`tauri dev` / debug profile): SQLite `sync_meta` in the local
//!   catalog DB — avoids repeated Keychain unlock prompts during development.
//!
//! Parascene rotates `prt_…` refresh tokens on every successful refresh. FE and Rust
//! must not refresh concurrently or the loser keeps a dead refresh token.

#[cfg(not(debug_assertions))]
use keyring::Entry;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[cfg(not(debug_assertions))]
const SERVICE: &str = "com.parascene.desktop";

const SESSION_KEY: &str = "parascene_session";
/// Must match `PARASCENE_CLIENT_ID` / base URL in the TypeScript config.
const OAUTH_CLIENT_ID: &str = "c7826d84-92b2-42b5-92db-473662b51a77";
const OAUTH_BASE_URL: &str = "https://www.parascene.com";
const ACCESS_TOKEN_SKEW_MS: u64 = 60_000;
const SESSION_EXPIRED_MSG: &str =
    "Session expired — reconnect to Parascene (refresh token invalidated)";

/// After `invalid_grant` with no recovery, skip further refresh HTTP until a new
/// session is written. Prevents download workers from serializing dozens of
/// doomed `/oauth/token` calls (main source of UI sluggishness on dead sessions).
fn refresh_invalidated() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_session_json() -> Option<Value> {
    let raw = keychain_get(SESSION_KEY.to_string()).ok().flatten()?;
    serde_json::from_str(&raw).ok()
}

fn write_session_json(value: &Value) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|e| e.to_string())?;
    keychain_set(SESSION_KEY.to_string(), raw)?;
    refresh_invalidated().store(false, Ordering::SeqCst);
    Ok(())
}

fn access_from_session(session: &Value) -> Option<String> {
    session
        .get("accessToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn refresh_from_session(session: &Value) -> Option<String> {
    session
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn expires_at_ms(session: &Value) -> u64 {
    session
        .get("expiresAtMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

fn access_still_fresh(session: &Value) -> bool {
    expires_at_ms(session) > now_ms().saturating_add(ACCESS_TOKEN_SKEW_MS)
}

/// Fresh access token for API / media downloads (refreshes when near expiry).
pub async fn ensure_access_token() -> Result<String, String> {
    ensure_access_token_inner(false).await
}

/// Force a refresh (e.g. after an authenticated media GET returns 401/403).
pub async fn force_refresh_access_token() -> Result<String, String> {
    ensure_access_token_inner(true).await
}

async fn ensure_access_token_inner(force: bool) -> Result<String, String> {
    if refresh_invalidated().load(Ordering::SeqCst) {
        return Err(SESSION_EXPIRED_MSG.into());
    }

    // Read outside the refresh lock so Sync/downloads don't serialize behind HTTP.
    let session = tokio::task::spawn_blocking(read_session_json)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Not signed in".to_string())?;
    let access = access_from_session(&session).ok_or_else(|| "Not signed in".to_string())?;
    if !force && access_still_fresh(&session) {
        return Ok(access);
    }

    // Only serialize the rotating refresh itself.
    let _guard = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        refresh_lock().lock(),
    )
    .await
    .map_err(|_| {
        "Session check timed out — another refresh is still running. Try again in a moment."
            .to_string()
    })?;

    if refresh_invalidated().load(Ordering::SeqCst) {
        return Err(SESSION_EXPIRED_MSG.into());
    }

    // Re-read after acquiring the lock — another worker may have refreshed.
    let session = tokio::task::spawn_blocking(read_session_json)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Not signed in".to_string())?;
    let access = access_from_session(&session).ok_or_else(|| "Not signed in".to_string())?;
    if !force && access_still_fresh(&session) {
        return Ok(access);
    }

    let refresh = refresh_from_session(&session)
        .ok_or_else(|| "Session expired — reconnect to Parascene".to_string())?;

    match refresh_access_token_http(&refresh).await {
        Ok(next) => {
            let session_for_write = session.clone();
            let next_clone = RefreshedTokens {
                access_token: next.access_token.clone(),
                refresh_token: next.refresh_token.clone(),
                expires_at_ms: next.expires_at_ms,
                expires_in_secs: next.expires_in_secs,
            };
            tokio::task::spawn_blocking(move || {
                let mut session = session_for_write;
                persist_refreshed(&mut session, &next_clone)
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(next.access_token)
        }
        Err(err) => {
            // Another party may have already rotated+persisted while we held a stale copy.
            if err.contains("invalid_grant") {
                if let Some(latest) = tokio::task::spawn_blocking(read_session_json)
                    .await
                    .map_err(|e| e.to_string())?
                {
                    if access_still_fresh(&latest) {
                        if let Some(token) = access_from_session(&latest) {
                            eprintln!(
                                "[auth] refresh invalid_grant but store already has a fresh access token"
                            );
                            return Ok(token);
                        }
                    }
                    if let Some(newer_refresh) = refresh_from_session(&latest) {
                        if newer_refresh != refresh {
                            eprintln!(
                                "[auth] refresh token rotated elsewhere — retrying once with store value"
                            );
                            let next = refresh_access_token_http(&newer_refresh).await?;
                            let next_clone = RefreshedTokens {
                                access_token: next.access_token.clone(),
                                refresh_token: next.refresh_token.clone(),
                                expires_at_ms: next.expires_at_ms,
                                expires_in_secs: next.expires_in_secs,
                            };
                            tokio::task::spawn_blocking(move || {
                                let mut latest = latest;
                                persist_refreshed(&mut latest, &next_clone)
                            })
                            .await
                            .map_err(|e| e.to_string())??;
                            return Ok(next.access_token);
                        }
                    }
                }
                refresh_invalidated().store(true, Ordering::SeqCst);
                eprintln!("[auth] refresh token invalidated — stopping further refresh attempts");
                return Err(SESSION_EXPIRED_MSG.into());
            }
            Err(err)
        }
    }
}

fn persist_refreshed(session: &mut Value, next: &RefreshedTokens) -> Result<(), String> {
    if let Some(obj) = session.as_object_mut() {
        obj.insert("accessToken".into(), json!(next.access_token));
        obj.insert("expiresAtMs".into(), json!(next.expires_at_ms));
        if let Some(rt) = next.refresh_token.as_ref() {
            obj.insert("refreshToken".into(), json!(rt));
        }
    }
    write_session_json(session)?;
    eprintln!(
        "[auth] refreshed access token (expires in {}s)",
        next.expires_in_secs
    );
    Ok(())
}

#[derive(Clone)]
struct RefreshedTokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at_ms: u64,
    expires_in_secs: u64,
}

async fn refresh_access_token_http(refresh_token: &str) -> Result<RefreshedTokens, String> {
    let body = json!({
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    });
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("ParasceneDesktop/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(format!("{OAUTH_BASE_URL}/oauth/token"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("timed out") || msg.contains("timeout") {
                "Token refresh timed out — check your network and try again".to_string()
            } else {
                format!("Token refresh failed: {msg}")
            }
        })?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "Token refresh failed (HTTP {}): {}",
            status.as_u16(),
            text.chars().take(160).collect::<String>()
        ));
    }
    let data: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let access_token = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Token refresh missing access_token".to_string())?
        .to_string();
    let expires_in_secs = data
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(900);
    let refresh_token = data
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Ok(RefreshedTokens {
        access_token,
        refresh_token,
        expires_at_ms: now_ms().saturating_add(expires_in_secs.saturating_mul(1000)),
        expires_in_secs,
    })
}

/// Single entry point for FE + Rust download workers.
#[tauri::command]
pub async fn auth_ensure_access_token(force: Option<bool>) -> Result<String, String> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(12),
        ensure_access_token_inner(force.unwrap_or(false)),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(
            "Session check timed out — check your network, or reconnect if this keeps happening."
                .into(),
        ),
    }
}

#[tauri::command]
pub fn keychain_get(key: String) -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    {
        crate::library::auth_kv_get(&key)
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub fn keychain_set(key: String, value: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        crate::library::auth_kv_set(&key, &value)?;
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())?;
    }
    if key == SESSION_KEY {
        refresh_invalidated().store(false, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub fn keychain_delete(key: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        crate::library::auth_kv_delete(&key)
    }
    #[cfg(not(debug_assertions))]
    {
        let entry = Entry::new(SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
