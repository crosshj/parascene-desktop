//! Durable project documents in `user.sqlite`.
//!
//! Frontend `localStorage` is no longer the store. First load imports the
//! last logout compact (`kv.parascene.projects.v1`) and any in-session FE
//! snapshot, then native owns reads and writes. Empty imports never replace
//! a non-empty store.

use super::paths::account_root;
use super::user_state::{open_user_db, user_db_path};
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

pub const PROJECTS_KV_KEY: &str = "parascene.projects.v1";
const META_MIGRATED: &str = "projects_native_v1";

fn sha256_hex(s: &str) -> String {
    let digest = Sha256::digest(s.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
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
    .map_err(|e| e.to_string())
}

fn is_migrated_conn(conn: &rusqlite::Connection) -> Result<bool, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM user_meta WHERE key = ?1",
            params![META_MIGRATED],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(value.as_deref() == Some("1"))
}

pub fn is_migrated(account_root: &Path) -> Result<bool, String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(false);
    }
    let conn = open_user_db(&path)?;
    ensure_schema(&conn)?;
    is_migrated_conn(&conn)
}

fn load_rows(conn: &rusqlite::Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT json FROM project_documents ORDER BY sort_index ASC, id ASC")
        .map_err(|e| e.to_string())?;
    let mapped = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in mapped {
        let raw = row.map_err(|e| e.to_string())?;
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => out.push(value),
            Err(_) => out.push(json!({ "id": "unreadable-row", "raw": raw })),
        }
    }
    Ok(out)
}

fn parse_array(raw: &str) -> Option<Vec<Value>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "[]" {
        return None;
    }
    let value: Value = serde_json::from_str(trimmed).ok()?;
    let rows = value.as_array()?.clone();
    if rows.is_empty() {
        None
    } else {
        Some(rows)
    }
}

fn row_id(row: &Value, fallback: usize) -> String {
    row.get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| id.to_string())
        .unwrap_or_else(|| format!("malformed-row-{fallback}"))
}

fn row_updated(row: &Value) -> Option<&str> {
    row.get("updatedAt")
        .or_else(|| row.get("updated_at"))
        .and_then(|v| v.as_str())
}

fn fe_is_newer_or_equal(fe: &Value, kv: &Value) -> bool {
    match (row_updated(fe), row_updated(kv)) {
        (Some(a), Some(b)) => a >= b,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => true,
    }
}

/// Last-logout compact (kv) is the durable base. In-session FE rows overlay
/// when they are newer or introduce ids the compact never saw.
pub fn merge_project_rows(kv: Vec<Value>, fe: Vec<Value>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut map: BTreeMap<String, Value> = BTreeMap::new();
    for (index, row) in kv.into_iter().enumerate() {
        let id = row_id(&row, index + 1);
        if !map.contains_key(&id) {
            order.push(id.clone());
        }
        map.insert(id, row);
    }
    for (index, row) in fe.into_iter().enumerate() {
        let id = row_id(&row, 10_000 + index + 1);
        match map.get(&id) {
            None => {
                order.push(id.clone());
                map.insert(id, row);
            }
            Some(existing) if fe_is_newer_or_equal(&row, existing) => {
                map.insert(id, row);
            }
            _ => {}
        }
    }
    order.into_iter().filter_map(|id| map.remove(&id)).collect()
}

fn replace_rows(
    conn: &rusqlite::Connection,
    rows: &[Value],
    allow_empty: bool,
) -> Result<(), String> {
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM project_documents", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if rows.is_empty() && count > 0 && !allow_empty {
        return Err("Refusing to overwrite non-empty project documents with []".into());
    }
    conn.execute("DELETE FROM project_documents", [])
        .map_err(|e| e.to_string())?;
    for (index, row) in rows.iter().enumerate() {
        let id = row_id(row, index + 1);
        let json = serde_json::to_string(row).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO project_documents(id, sort_index, json, sha256) VALUES (?1, ?2, ?3, ?4)",
            params![id, index as i64, json, sha256_hex(&json)],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT INTO user_meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_MIGRATED, "1"],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn kv_get(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(|e| e.to_string())
}

fn kv_put(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO kv(key, value, sha256) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, sha256 = excluded.sha256",
        params![key, value, sha256_hex(value)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn write_kv_backup(conn: &rusqlite::Connection, rows: &[Value]) -> Result<(), String> {
    let json = serde_json::to_string(rows).map_err(|e| e.to_string())?;
    kv_put(conn, PROJECTS_KV_KEY, &json)
}

pub fn export_json(account_root: &Path) -> Result<Option<String>, String> {
    let path = user_db_path(account_root);
    if !path.is_file() {
        return Ok(None);
    }
    let conn = open_user_db(&path)?;
    ensure_schema(&conn)?;
    if !is_migrated_conn(&conn)? {
        return kv_get(&conn, PROJECTS_KV_KEY);
    }
    let rows = load_rows(&conn)?;
    Ok(Some(serde_json::to_string(&rows).map_err(|e| e.to_string())?))
}

/// After native migration, compact/checkpoint must carry the native snapshot
/// — not a stale or empty FE `localStorage` copy.
pub fn inject_native_projects_backup(
    account_root: &Path,
    local_storage: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    if !is_migrated(account_root)? {
        return Ok(());
    }
    match export_json(account_root)? {
        Some(json) => {
            local_storage.insert(PROJECTS_KV_KEY.to_string(), json);
        }
        None => {
            local_storage.remove(PROJECTS_KV_KEY);
        }
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsMigrateRequest {
    #[serde(default)]
    pub fe_json: Option<String>,
}

#[tauri::command]
pub fn projects_migrate_and_load(request: ProjectsMigrateRequest) -> Result<Value, String> {
    let root = account_root()?;
    let path = user_db_path(&root);
    let conn = open_user_db(&path)?;
    ensure_schema(&conn)?;

    let fe_rows = request
        .fe_json
        .as_deref()
        .and_then(parse_array)
        .unwrap_or_default();

    if is_migrated_conn(&conn)? {
        let native_rows = load_rows(&conn)?;
        if fe_rows.is_empty() {
            return Ok(json!({ "rows": native_rows }));
        }
        let merged = merge_project_rows(native_rows.clone(), fe_rows);
        if merged != native_rows {
            replace_rows(&conn, &merged, native_rows.is_empty())?;
            write_kv_backup(&conn, &merged)?;
        }
        return Ok(json!({ "rows": merged }));
    }

    let kv_rows = kv_get(&conn, PROJECTS_KV_KEY)?
        .as_deref()
        .and_then(parse_array)
        .unwrap_or_default();
    let merged = merge_project_rows(kv_rows, fe_rows);
    replace_rows(&conn, &merged, true)?;
    write_kv_backup(&conn, &merged)?;
    Ok(json!({ "rows": merged }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsSaveRequest {
    pub rows: Value,
    #[serde(default)]
    pub allow_empty: bool,
}

#[tauri::command]
pub fn projects_save(request: ProjectsSaveRequest) -> Result<Value, String> {
    let root = account_root()?;
    let path = user_db_path(&root);
    let conn = open_user_db(&path)?;
    ensure_schema(&conn)?;
    let rows = request
        .rows
        .as_array()
        .cloned()
        .ok_or_else(|| "Project save requires a JSON array".to_string())?;
    replace_rows(&conn, &rows, request.allow_empty)?;
    write_kv_backup(&conn, &rows)?;
    Ok(json!({ "ok": true, "count": rows.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::env;
    use std::fs;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = env::temp_dir().join(format!(
            "parascene-projects-{label}-{}-{}",
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

    fn open(root: &Path) -> Connection {
        let conn = open_user_db(&user_db_path(root)).unwrap();
        ensure_schema(&conn).unwrap();
        conn
    }

    fn project(id: &str, title: &str, updated: &str) -> Value {
        json!({ "id": id, "title": title, "creationIds": [], "updatedAt": updated })
    }

    #[test]
    fn merge_keeps_kv_and_overlays_newer_fe() {
        let kv = vec![
            project("a", "Old A", "2026-01-01T00:00:00.000Z"),
            project("b", "B", "2026-01-01T00:00:00.000Z"),
        ];
        let fe = vec![
            project("a", "New A", "2026-02-01T00:00:00.000Z"),
            project("c", "C", "2026-02-01T00:00:00.000Z"),
        ];
        let merged = merge_project_rows(kv, fe);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0]["title"], "New A");
        assert_eq!(merged[1]["id"], "b");
        assert_eq!(merged[2]["id"], "c");
    }

    #[test]
    fn merge_does_not_let_older_fe_clobber_kv() {
        let kv = vec![project("a", "Kv", "2026-03-01T00:00:00.000Z")];
        let fe = vec![project("a", "Fe", "2026-01-01T00:00:00.000Z")];
        let merged = merge_project_rows(kv, fe);
        assert_eq!(merged[0]["title"], "Kv");
    }

    #[test]
    fn empty_save_refused_when_rows_exist() {
        let root = temp_root("refuse-empty");
        let conn = open(&root);
        replace_rows(&conn, &[project("a", "A", "2026-01-01T00:00:00.000Z")], true).unwrap();
        let err = replace_rows(&conn, &[], false).unwrap_err();
        assert!(err.contains("Refusing"));
        assert_eq!(load_rows(&conn).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_save_allowed_for_intentional_delete() {
        let root = temp_root("allow-empty");
        let conn = open(&root);
        replace_rows(&conn, &[project("a", "A", "2026-01-01T00:00:00.000Z")], true).unwrap();
        replace_rows(&conn, &[], true).unwrap();
        assert!(load_rows(&conn).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrated_overlays_newer_fe_and_keeps_native() {
        let root = temp_root("overlay");
        let conn = open(&root);
        replace_rows(
            &conn,
            &[
                project("a", "Native A", "2026-03-01T00:00:00.000Z"),
                project("b", "Native B", "2026-03-01T00:00:00.000Z"),
            ],
            true,
        )
        .unwrap();
        let merged = merge_project_rows(
            load_rows(&conn).unwrap(),
            vec![
                project("a", "Older FE", "2026-01-01T00:00:00.000Z"),
                project("c", "New FE", "2026-04-01T00:00:00.000Z"),
            ],
        );
        replace_rows(&conn, &merged, false).unwrap();
        let loaded = load_rows(&conn).unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0]["title"], "Native A");
        assert_eq!(loaded[1]["id"], "b");
        assert_eq!(loaded[2]["id"], "c");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn first_import_prefers_kv_then_new_fe_ids() {
        let root = temp_root("import");
        let conn = open(&root);
        kv_put(
            &conn,
            PROJECTS_KV_KEY,
            &json!([project("a", "Kv", "2026-01-01T00:00:00.000Z")]).to_string(),
        )
        .unwrap();
        let merged = merge_project_rows(
            parse_array(&kv_get(&conn, PROJECTS_KV_KEY).unwrap().unwrap()).unwrap(),
            vec![project("b", "Fe", "2026-02-01T00:00:00.000Z")],
        );
        replace_rows(&conn, &merged, true).unwrap();
        let loaded = load_rows(&conn).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["id"], "a");
        assert_eq!(loaded[1]["id"], "b");
        let _ = fs::remove_dir_all(&root);
    }
}
