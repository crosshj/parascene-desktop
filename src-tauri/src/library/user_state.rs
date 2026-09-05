//! Per-account `user.sqlite` — compact of WebView KV, secrets, identity, queues.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub const USER_DB_NAME: &str = "user.sqlite";

/// Machine-global secrets that belong in the user bundle (not live OAuth).
pub const SECRET_KEYS: &[&str] = &[
    "parascene_openai_api_key",
    "replicate_api_token",
    "blue_provider_credentials",
];

pub fn is_account_secret_key(key: &str) -> bool {
    SECRET_KEYS.iter().any(|k| *k == key)
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentity {
    pub sub: String,
    #[serde(default, alias = "preferred_username")]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompactPayload {
    #[serde(default)]
    pub local_storage: BTreeMap<String, String>,
    pub identity: UserIdentity,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HydratePayload {
    pub local_storage: BTreeMap<String, String>,
    pub identity: Option<UserIdentity>,
    #[serde(default)]
    pub present: bool,
}

fn sha256_hex(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn open_user_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create account dir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("Could not open user.sqlite: {e}"))?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          sha256 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS secrets (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          sub TEXT NOT NULL,
          json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS queues (
          kind TEXT PRIMARY KEY NOT NULL,
          json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_documents (
          id TEXT PRIMARY KEY NOT NULL,
          sort_index INTEGER NOT NULL,
          json TEXT NOT NULL,
          sha256 TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(conn)
}

pub fn user_db_path(account_root: &Path) -> std::path::PathBuf {
    account_root.join(USER_DB_NAME)
}

pub fn write_compact(
    account_root: &Path,
    payload: &CompactPayload,
    secrets: &BTreeMap<String, String>,
    queues: &BTreeMap<String, Value>,
) -> Result<(), String> {
    if payload.identity.sub.trim().is_empty() {
        return Err("Compact requires identity.sub".into());
    }
    let path = user_db_path(account_root);
    let conn = open_user_db(&path)?;
    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let result = (|| {
        conn.execute("DELETE FROM kv", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM secrets", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM queues", [])
            .map_err(|e| e.to_string())?;
        for (key, value) in &payload.local_storage {
            conn.execute(
                "INSERT INTO kv(key, value, sha256) VALUES (?1, ?2, ?3)",
                params![key, value, sha256_hex(value)],
            )
            .map_err(|e| e.to_string())?;
        }
        for (key, value) in secrets {
            conn.execute(
                "INSERT INTO secrets(key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        let ident = serde_json::to_string(&payload.identity).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO identity(id, sub, json) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET sub = excluded.sub, json = excluded.json",
            params![payload.identity.sub, ident],
        )
        .map_err(|e| e.to_string())?;
        for (kind, json) in queues {
            let raw = serde_json::to_string(json).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO queues(kind, json) VALUES (?1, ?2)",
                params![kind, raw],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

pub fn verify_compact(account_root: &Path, payload: &CompactPayload) -> Result<(), String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Err("user.sqlite missing after compact".into());
    }
    let conn = open_user_db(&path)?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM kv", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if count as usize != payload.local_storage.len() {
        return Err(format!(
            "user.sqlite kv count {count} != snapshot {}",
            payload.local_storage.len()
        ));
    }
    for (key, value) in &payload.local_storage {
        let row: (String, String) = conn
            .query_row(
                "SELECT value, sha256 FROM kv WHERE key = ?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|_| format!("user.sqlite missing key {key}"))?;
        if row.0 != *value || row.1 != sha256_hex(value) {
            return Err(format!("user.sqlite hash mismatch for {key}"));
        }
    }
    let sub: String = conn
        .query_row("SELECT sub FROM identity WHERE id = 1", [], |row| row.get(0))
        .map_err(|_| "user.sqlite missing identity".to_string())?;
    if sub != payload.identity.sub {
        return Err("user.sqlite identity.sub mismatch".into());
    }
    Ok(())
}

pub fn read_hydrate(account_root: &Path) -> Result<HydratePayload, String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(HydratePayload::default());
    }
    let conn = open_user_db(&path)?;
    let mut local_storage = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT key, value FROM kv")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        local_storage.insert(k, v);
    }
    let identity = conn
        .query_row("SELECT json FROM identity WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    Ok(HydratePayload {
        local_storage,
        identity,
        present: true,
    })
}

pub fn read_secrets(account_root: &Path) -> Result<BTreeMap<String, String>, String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    let conn = open_user_db(&path)?;
    let mut out = BTreeMap::new();
    let mut stmt = conn
        .prepare("SELECT key, value FROM secrets")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        out.insert(k, v);
    }
    Ok(out)
}

/// Live keychain snapshot wins when it has anything. An empty snapshot must not
/// wipe secrets already compacted into `user.sqlite` (debug/OS store mismatch).
pub fn merge_secrets_for_compact(
    account_root: &Path,
    live: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    if !live.is_empty() {
        return Ok(live.clone());
    }
    read_secrets(account_root)
}

pub fn upsert_secret(account_root: &Path, key: &str, value: &str) -> Result<(), String> {
    if !is_account_secret_key(key) || value.trim().is_empty() {
        return Ok(());
    }
    let path = user_db_path(account_root);
    let conn = open_user_db(&path)?;
    conn.execute(
        "INSERT INTO secrets(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_secret_row(account_root: &Path, key: &str) -> Result<(), String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(());
    }
    let conn = open_user_db(&path)?;
    conn.execute("DELETE FROM secrets WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist a Settings secret into the bound account as soon as it is saved.
/// No-op when no account is bound (login screen / tests).
pub fn mirror_live_secret(key: &str, value: Option<&str>) {
    if !is_account_secret_key(key) {
        return;
    }
    let Ok(root) = super::paths::account_root() else {
        return;
    };
    match value {
        Some(v) if !v.trim().is_empty() => {
            let _ = upsert_secret(&root, key, v);
        }
        _ => {
            let _ = delete_secret_row(&root, key);
        }
    }
}

pub fn rewrite_prefix_in_user_db(
    account_root: &Path,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<u32, String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(0);
    }
    let conn = open_user_db(&path)?;
    let mut changed = 0u32;
    changed += replace_text_column(&conn, "kv", "value", old_prefix, new_prefix)?;
    changed += replace_text_column(&conn, "secrets", "value", old_prefix, new_prefix)?;
    changed += replace_text_column(&conn, "identity", "json", old_prefix, new_prefix)?;
    changed += replace_text_column(&conn, "queues", "json", old_prefix, new_prefix)?;
    rehash_kv(&conn)?;
    Ok(changed)
}

pub fn leftover_old_prefix_in_user_db(
    account_root: &Path,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<(), String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(());
    }
    let conn = open_user_db(&path)?;
    let leftover: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM kv
             WHERE instr(value, ?1) > 0 AND instr(value, ?2) = 0",
            params![old_prefix, new_prefix],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if leftover > 0 {
        return Err(format!(
            "{leftover} user.sqlite kv values still use the old root prefix"
        ));
    }
    Ok(())
}

fn rehash_kv(conn: &Connection) -> Result<(), String> {
    let pairs: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("SELECT key, value FROM kv")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        out
    };
    for (key, value) in pairs {
        conn.execute(
            "UPDATE kv SET sha256 = ?1 WHERE key = ?2",
            params![sha256_hex(&value), key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn replace_text_column(
    conn: &Connection,
    table: &str,
    column: &str,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<u32, String> {
    let sql = format!(
        "UPDATE {table} SET {column} = replace({column}, ?1, ?2) WHERE instr({column}, ?1) > 0"
    );
    let n = conn
        .execute(&sql, params![old_prefix, new_prefix])
        .map_err(|e| e.to_string())?;
    Ok(n as u32)
}

pub fn rewrite_prefix_in_json_files(
    dir: &Path,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<u32, String> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let mut changed = 0u32;
    walk_replace_json(dir, old_prefix, new_prefix, &mut changed)?;
    Ok(changed)
}

fn walk_replace_json(
    dir: &Path,
    old_prefix: &str,
    new_prefix: &str,
    changed: &mut u32,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            walk_replace_json(&path, old_prefix, new_prefix, changed)?;
            continue;
        }
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if !(name.ends_with(".json") || name.ends_with(".jsonl")) {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if !raw.contains(old_prefix) {
            continue;
        }
        let next = raw.replace(old_prefix, new_prefix);
        fs::write(&path, next).map_err(|e| format!("Rewrite {}: {e}", path.display()))?;
        *changed += 1;
    }
    Ok(())
}

/// Used by tests / debug: dump kv as a JSON object.
#[allow(dead_code)]
pub fn kv_as_object(account_root: &Path) -> Result<Map<String, Value>, String> {
    let hydrate = read_hydrate(account_root)?;
    let mut map = Map::new();
    for (k, v) in hydrate.local_storage {
        map.insert(k, Value::String(v));
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = env::temp_dir().join(format!(
            "parascene-userstate-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn compact_verify_hydrate_roundtrip() {
        let root = temp_root("roundtrip");
        let mut local_storage = BTreeMap::new();
        local_storage.insert("parascene.projects.v1".into(), "[{\"id\":\"p1\"}]".into());
        local_storage.insert("parascene.lab.foo".into(), "bar".into());
        let payload = CompactPayload {
            local_storage,
            identity: UserIdentity {
                sub: "auth0|owner".into(),
                name: Some("Pat".into()),
                ..Default::default()
            },
        };
        let mut secrets = BTreeMap::new();
        secrets.insert("replicate_api_token".into(), "r8_secret".into());
        write_compact(&root, &payload, &secrets, &BTreeMap::new()).unwrap();
        verify_compact(&root, &payload).unwrap();
        let hydrate = read_hydrate(&root).unwrap();
        assert_eq!(
            hydrate.local_storage.get("parascene.lab.foo").unwrap(),
            "bar"
        );
        assert_eq!(hydrate.identity.unwrap().sub, "auth0|owner");
        assert_eq!(
            read_secrets(&root).unwrap().get("replicate_api_token").unwrap(),
            "r8_secret"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn verify_fails_on_hash_mismatch() {
        let root = temp_root("mismatch");
        let mut local_storage = BTreeMap::new();
        local_storage.insert("k".into(), "v1".into());
        let payload = CompactPayload {
            local_storage,
            identity: UserIdentity {
                sub: "u1".into(),
                ..Default::default()
            },
        };
        write_compact(&root, &payload, &BTreeMap::new(), &BTreeMap::new()).unwrap();
        let mut other = payload.clone();
        other.local_storage.insert("k".into(), "v2".into());
        assert!(verify_compact(&root, &other).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rewrite_prefix_updates_kv() {
        let root = temp_root("rewrite");
        let mut local_storage = BTreeMap::new();
        local_storage.insert(
            "lab".into(),
            "/tmp/legacy-root/Library/media/x.wav".into(),
        );
        let payload = CompactPayload {
            local_storage,
            identity: UserIdentity {
                sub: "u1".into(),
                ..Default::default()
            },
        };
        write_compact(&root, &payload, &BTreeMap::new(), &BTreeMap::new()).unwrap();
        rewrite_prefix_in_user_db(&root, "/tmp/legacy-root", "/tmp/users/u1").unwrap();
        leftover_old_prefix_in_user_db(&root, "/tmp/legacy-root", "/tmp/users/u1").unwrap();
        let hydrate = read_hydrate(&root).unwrap();
        assert_eq!(
            hydrate.local_storage.get("lab").unwrap(),
            "/tmp/users/u1/Library/media/x.wav"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rewrite_prefix_updates_nested_json() {
        let root = temp_root("nested");
        let mut local_storage = BTreeMap::new();
        local_storage.insert(
            "parascene.lab.session".into(),
            r#"{"slice":"/tmp/legacy-root/Library/media/a.wav"}"#.into(),
        );
        let payload = CompactPayload {
            local_storage,
            identity: UserIdentity {
                sub: "u1".into(),
                ..Default::default()
            },
        };
        write_compact(&root, &payload, &BTreeMap::new(), &BTreeMap::new()).unwrap();
        rewrite_prefix_in_user_db(&root, "/tmp/legacy-root", "/tmp/users/u1").unwrap();
        leftover_old_prefix_in_user_db(&root, "/tmp/legacy-root", "/tmp/users/u1").unwrap();
        let hydrate = read_hydrate(&root).unwrap();
        assert!(hydrate
            .local_storage
            .get("parascene.lab.session")
            .unwrap()
            .contains("/tmp/users/u1/Library"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_live_secrets_keep_existing_compact() {
        let root = temp_root("keep-secrets");
        let payload = CompactPayload {
            identity: UserIdentity {
                sub: "u1".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut saved = BTreeMap::new();
        saved.insert("replicate_api_token".into(), "r8_keep".into());
        write_compact(&root, &payload, &saved, &BTreeMap::new()).unwrap();
        let merged = merge_secrets_for_compact(&root, &BTreeMap::new()).unwrap();
        assert_eq!(merged.get("replicate_api_token").unwrap(), "r8_keep");
        let mut live = BTreeMap::new();
        live.insert("replicate_api_token".into(), "r8_new".into());
        let merged_live = merge_secrets_for_compact(&root, &live).unwrap();
        assert_eq!(merged_live.get("replicate_api_token").unwrap(), "r8_new");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn upsert_secret_survives_empty_compact_snapshot() {
        let root = temp_root("upsert");
        upsert_secret(&root, "parascene_openai_api_key", "sk-test").unwrap();
        let merged = merge_secrets_for_compact(&root, &BTreeMap::new()).unwrap();
        assert_eq!(merged.get("parascene_openai_api_key").unwrap(), "sk-test");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn hydrate_payload_serializes_camel_case() {
        let mut local_storage = BTreeMap::new();
        local_storage.insert("parascene.previewQuality".into(), "high".into());
        let raw = serde_json::to_value(HydratePayload {
            local_storage,
            identity: None,
            present: true,
        })
        .unwrap();
        assert!(raw.get("localStorage").is_some());
        assert!(raw.get("local_storage").is_none());
    }
}
