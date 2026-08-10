use crate::auth_store::{keychain_delete, keychain_get, keychain_set};
use serde::{Deserialize, Serialize};

pub const CREDENTIALS_KEY: &str = "blue_provider_credentials";
/// Hardcoded Blue origin — not stored in Settings.
pub const BLUE_BASE_URL: &str = "https://blue.parascene.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueCredentials {
    pub token: String,
    pub cf_access_client_id: String,
    pub cf_access_client_secret: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsStatus {
    pub configured: bool,
    /// Masked preview of the bearer token only (never CF secret).
    pub preview: Option<String>,
}

fn mask_token(t: &str) -> String {
    if t.len() <= 8 {
        "••••".to_string()
    } else {
        format!("{}…{}", &t[..4], &t[t.len().saturating_sub(4)..])
    }
}

pub fn parse_credentials_json(raw: &str) -> Result<BlueCredentials, String> {
    let v: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("Invalid credentials JSON: {e}"))?;
    let token = v
        .get("token")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Credentials JSON must include non-empty \"token\" string field.".to_string()
        })?;
    let cf_id = v
        .get("cfAccessClientId")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Credentials JSON must include non-empty \"cfAccessClientId\" string field."
                .to_string()
        })?;
    let cf_secret = v
        .get("cfAccessClientSecret")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Credentials JSON must include non-empty \"cfAccessClientSecret\" string field."
                .to_string()
        })?;
    Ok(BlueCredentials {
        token: token.to_string(),
        cf_access_client_id: cf_id.to_string(),
        cf_access_client_secret: cf_secret.to_string(),
    })
}

fn credentials_from_env() -> Option<BlueCredentials> {
    let token = std::env::var("PARASCENE_BLUE_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let cf_id = std::env::var("PARASCENE_BLUE_CF_ACCESS_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let cf_secret = std::env::var("PARASCENE_BLUE_CF_ACCESS_CLIENT_SECRET")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    Some(BlueCredentials {
        token,
        cf_access_client_id: cf_id,
        cf_access_client_secret: cf_secret,
    })
}

/// Settings/keychain first; else optional process env (`PARASCENE_BLUE_*`).
pub fn get_credentials() -> Result<Option<BlueCredentials>, String> {
    let raw = keychain_get(CREDENTIALS_KEY.to_string())?;
    if let Some(raw) = raw.filter(|s| !s.trim().is_empty()) {
        return Ok(Some(parse_credentials_json(&raw)?));
    }
    Ok(credentials_from_env())
}

pub fn require_credentials() -> Result<BlueCredentials, String> {
    get_credentials()?.ok_or_else(|| {
        "Parascene Blue credentials not set. Add them in Settings (or PARASCENE_BLUE_* env)."
            .to_string()
    })
}

pub fn set_credentials_json(raw: String) -> Result<(), String> {
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        return clear_credentials();
    }
    let creds = parse_credentials_json(&trimmed)?;
    let stored = serde_json::json!({
        "token": creds.token,
        "cfAccessClientId": creds.cf_access_client_id,
        "cfAccessClientSecret": creds.cf_access_client_secret,
    });
    keychain_set(
        CREDENTIALS_KEY.to_string(),
        serde_json::to_string(&stored).map_err(|e| e.to_string())?,
    )
}

pub fn clear_credentials() -> Result<(), String> {
    match keychain_delete(CREDENTIALS_KEY.to_string()) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = keychain_set(CREDENTIALS_KEY.to_string(), String::new());
            Ok(())
        }
    }
}

pub fn credentials_status() -> Result<CredentialsStatus, String> {
    match get_credentials()? {
        None => Ok(CredentialsStatus {
            configured: false,
            preview: None,
        }),
        Some(c) => Ok(CredentialsStatus {
            configured: true,
            preview: Some(mask_token(&c.token)),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_requires_token_and_cf() {
        assert!(parse_credentials_json(r#"{"token":"t"}"#).is_err());
        let ok = parse_credentials_json(
            r#"{"token":"tok","cfAccessClientId":"id","cfAccessClientSecret":"sec"}"#,
        )
        .unwrap();
        assert_eq!(ok.token, "tok");
        assert_eq!(ok.cf_access_client_id, "id");
        assert_eq!(ok.cf_access_client_secret, "sec");
    }

    #[test]
    fn parse_ignores_base_url_in_json() {
        let ok = parse_credentials_json(
            r#"{"baseUrl":"http://127.0.0.1:8787/","token":"tok","cfAccessClientId":"id","cfAccessClientSecret":"sec"}"#,
        )
        .unwrap();
        assert_eq!(ok.token, "tok");
    }
}
