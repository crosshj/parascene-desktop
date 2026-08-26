use crate::auth_store::{keychain_delete, keychain_get, keychain_set};
use serde::Serialize;

pub const TOKEN_KEY: &str = "replicate_api_token";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub configured: bool,
    /// Masked preview when configured (never the full secret).
    pub preview: Option<String>,
}

pub fn get_token() -> Result<Option<String>, String> {
    let raw = keychain_get(TOKEN_KEY.to_string())?;
    Ok(raw.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    }))
}

pub fn require_token() -> Result<String, String> {
    get_token()?.ok_or_else(|| "Replicate API token not set. Add it in Settings.".to_string())
}

pub fn set_token(token: String) -> Result<(), String> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return clear_token();
    }
    keychain_set(TOKEN_KEY.to_string(), trimmed)
}

pub fn clear_token() -> Result<(), String> {
    match keychain_delete(TOKEN_KEY.to_string()) {
        Ok(()) => Ok(()),
        Err(_) => {
            // Missing key is fine.
            let _ = keychain_set(TOKEN_KEY.to_string(), String::new());
            Ok(())
        }
    }
}

pub fn token_status() -> Result<TokenStatus, String> {
    match get_token()? {
        None => Ok(TokenStatus {
            configured: false,
            preview: None,
        }),
        Some(t) => {
            let preview = if t.len() <= 8 {
                Some("••••".to_string())
            } else {
                Some(format!("{}…{}", &t[..4], &t[t.len().saturating_sub(4)..]))
            };
            Ok(TokenStatus {
                configured: true,
                preview,
            })
        }
    }
}
