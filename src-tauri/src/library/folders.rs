//! Library folders with durable pending ops for Parascene cloud sync.

use super::catalog::{default_paths, meta_get, meta_set, ready_connection};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const META_REVISION: &str = "library_folders_revision";
const META_BASELINE: &str = "library_folders_baseline";
const CREATION_IDS_MAX: usize = 500;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFolder {
    pub id: String,
    pub title: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    pub member_ids: Vec<String>,
    pub member_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudFolderRow {
    pub id: String,
    pub title: String,
    pub description: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub creation_ids: Vec<String>,
    pub member_count: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFolderOp {
    pub seq: i64,
    pub op: JsonValue,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSyncState {
    pub revision: Option<i64>,
    pub pending_ops: Vec<PendingFolderOp>,
    pub folders: Vec<LibraryFolder>,
    pub baseline_folders: Vec<CloudFolderRow>,
}

fn is_uuid(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.len() != 36 {
        return false;
    }
    // Lightweight check without pulling regex crate into hot paths.
    let bytes = trimmed.as_bytes();
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return false;
    }
    let version = bytes[14];
    if !(b'1'..=b'5').contains(&version) {
        return false;
    }
    let variant = bytes[19].to_ascii_lowercase();
    if !matches!(variant, b'8' | b'9' | b'a' | b'b') {
        return false;
    }
    trimmed
        .bytes()
        .enumerate()
        .all(|(i, b)| matches!(i, 8 | 13 | 18 | 23) || b.is_ascii_hexdigit())
}

fn new_folder_id() -> String {
    Uuid::new_v4().to_string()
}

fn normalize_title(title: &str) -> String {
    let t = title.trim();
    if t.is_empty() {
        "Untitled folder".into()
    } else {
        t.to_string()
    }
}

fn cloud_creation_ids(ids: &[String]) -> Vec<i64> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let Ok(n) = id.trim().parse::<i64>() else {
            continue;
        };
        if n <= 0 || !seen.insert(n) {
            continue;
        }
        out.push(n);
        if out.len() >= CREATION_IDS_MAX {
            break;
        }
    }
    out
}

fn is_local_only_creation_id(id: &str) -> bool {
    match id.trim().parse::<i64>() {
        Ok(n) => n <= 0,
        Err(_) => true,
    }
}

fn load_member_ids(conn: &Connection, folder_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT creation_id FROM folder_items
             WHERE folder_id = ?1
             ORDER BY added_at ASC, creation_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![folder_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn folder_from_row(
    conn: &Connection,
    id: String,
    title: String,
    description: String,
    created_at: String,
    updated_at: String,
) -> Result<LibraryFolder, String> {
    let member_ids = load_member_ids(conn, &id)?;
    let member_count = member_ids.len() as u32;
    Ok(LibraryFolder {
        id,
        title,
        description,
        created_at,
        updated_at,
        member_ids,
        member_count,
    })
}

fn get_folder(conn: &Connection, id: &str) -> Result<Option<LibraryFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, created_at, updated_at
             FROM folders WHERE id = ?1 LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    let Some(row) = rows.next().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    Ok(Some(folder_from_row(
        conn,
        row.get(0).map_err(|e| e.to_string())?,
        row.get(1).map_err(|e| e.to_string())?,
        row.get(2).map_err(|e| e.to_string())?,
        row.get(3).map_err(|e| e.to_string())?,
        row.get(4).map_err(|e| e.to_string())?,
    )?))
}

fn list_folders(conn: &Connection) -> Result<Vec<LibraryFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, created_at, updated_at
             FROM folders
             ORDER BY updated_at DESC, title ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, description, created_at, updated_at) = row.map_err(|e| e.to_string())?;
        out.push(folder_from_row(
            conn,
            id,
            title,
            description,
            created_at,
            updated_at,
        )?);
    }
    Ok(out)
}

fn touch_folder(conn: &Connection, folder_id: &str, now: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE folders SET updated_at = ?1 WHERE id = ?2",
        params![now, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn enqueue_op(conn: &Connection, op: JsonValue) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let op_json = serde_json::to_string(&op).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO folder_pending_ops(op_json, created_at) VALUES (?1, ?2)",
        params![op_json, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_pending_ops(conn: &Connection) -> Result<Vec<PendingFolderOp>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT seq, op_json, created_at FROM folder_pending_ops
             ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (seq, op_json, created_at) = row.map_err(|e| e.to_string())?;
        let op: JsonValue = serde_json::from_str(&op_json).map_err(|e| e.to_string())?;
        out.push(PendingFolderOp {
            seq,
            op,
            created_at,
        });
    }
    Ok(out)
}

fn read_revision(conn: &Connection) -> Result<Option<i64>, String> {
    let Some(raw) = meta_get(conn, META_REVISION)? else {
        return Ok(None);
    };
    let n: i64 = raw.trim().parse().map_err(|_| "invalid folder revision".to_string())?;
    Ok(Some(n))
}

fn write_revision(conn: &Connection, revision: i64) -> Result<(), String> {
    meta_set(conn, META_REVISION, &revision.to_string())
}

fn read_baseline(conn: &Connection) -> Result<Vec<CloudFolderRow>, String> {
    let Some(raw) = meta_get(conn, META_BASELINE)? else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_baseline(conn: &Connection, folders: &[CloudFolderRow]) -> Result<(), String> {
    let raw = serde_json::to_string(folders).map_err(|e| e.to_string())?;
    meta_set(conn, META_BASELINE, &raw)
}

/// Migrate legacy folder ids to UUIDs and ensure pending creates exist before first sync.
pub(crate) fn ensure_folder_sync_ready(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT id FROM folders")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for old_id in ids {
        if is_uuid(&old_id) {
            continue;
        }
        let new_id = new_folder_id();
        let folder = get_folder(conn, &old_id)?
            .ok_or_else(|| format!("Missing folder {old_id} during UUID migration"))?;
        // Insert the UUID row first so membership FKs stay valid, then re-point items.
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                new_id,
                folder.title,
                folder.description,
                folder.created_at,
                folder.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE folder_items SET folder_id = ?1 WHERE folder_id = ?2",
            params![new_id, old_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM folders WHERE id = ?1", params![old_id])
            .map_err(|e| e.to_string())?;

        let migrated = get_folder(conn, &new_id)?
            .ok_or_else(|| format!("Missing folder {new_id} after UUID migration"))?;
        let mut create_op = json!({
            "op": "create",
            "id": migrated.id,
            "title": migrated.title,
            "description": migrated.description,
        });
        let cloud_ids = cloud_creation_ids(&migrated.member_ids);
        if !cloud_ids.is_empty() {
            create_op["creation_ids"] = json!(cloud_ids);
        }
        enqueue_op(conn, create_op)?;
    }

    // First-time sync: local UUID folders with no revision need create ops.
    if read_revision(conn)?.is_none() {
        let pending = list_pending_ops(conn)?;
        let mut pending_create_ids = std::collections::HashSet::new();
        for op in &pending {
            if op.op.get("op").and_then(|v| v.as_str()) == Some("create") {
                if let Some(id) = op.op.get("id").and_then(|v| v.as_str()) {
                    pending_create_ids.insert(id.to_string());
                }
            }
        }
        for folder in list_folders(conn)? {
            if pending_create_ids.contains(&folder.id) {
                continue;
            }
            let mut create_op = json!({
                "op": "create",
                "id": folder.id,
                "title": folder.title,
                "description": folder.description,
            });
            let cloud_ids = cloud_creation_ids(&folder.member_ids);
            if !cloud_ids.is_empty() {
                create_op["creation_ids"] = json!(cloud_ids);
            }
            enqueue_op(conn, create_op)?;
        }
    }

    Ok(())
}

/// Remove prior memberships, then insert into `folder_id`.
fn move_creations_into_folder(
    conn: &Connection,
    folder_id: &str,
    creation_ids: &[String],
    now: &str,
) -> Result<(), String> {
    if creation_ids.is_empty() {
        return Ok(());
    }

    let mut other_folders: Vec<String> = Vec::new();
    for creation_id in creation_ids {
        let mut stmt = conn
            .prepare(
                "SELECT folder_id FROM folder_items
                 WHERE creation_id = ?1 AND folder_id != ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![creation_id, folder_id], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let id = row.map_err(|e| e.to_string())?;
            if !other_folders.contains(&id) {
                other_folders.push(id);
            }
        }
        conn.execute(
            "DELETE FROM folder_items WHERE creation_id = ?1",
            params![creation_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![folder_id, creation_id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    touch_folder(conn, folder_id, now)?;
    for other in other_folders {
        touch_folder(conn, &other, now)?;
    }
    Ok(())
}

fn create_folder(
    conn: &Connection,
    title: &str,
    creation_ids: &[String],
) -> Result<LibraryFolder, String> {
    let title = normalize_title(title);
    let id = new_folder_id();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders(id, title, description, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, ?3)",
        params![id, title, now],
    )
    .map_err(|e| e.to_string())?;
    move_creations_into_folder(conn, &id, creation_ids, &now)?;
    let mut create_op = json!({
        "op": "create",
        "id": id,
        "title": title,
        "description": "",
    });
    let cloud_ids = cloud_creation_ids(creation_ids);
    if !cloud_ids.is_empty() {
        create_op["creation_ids"] = json!(cloud_ids);
    }
    enqueue_op(conn, create_op)?;
    get_folder(conn, &id)?.ok_or_else(|| format!("Missing folder {id} after create"))
}

fn rename_folder(
    conn: &Connection,
    id: &str,
    title: &str,
    description: &str,
) -> Result<LibraryFolder, String> {
    let title = normalize_title(title);
    let now = Utc::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE folders SET title = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, description, now, id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Folder not found".into());
    }
    enqueue_op(
        conn,
        json!({
            "op": "update",
            "id": id,
            "title": title,
            "description": description,
        }),
    )?;
    get_folder(conn, id)?.ok_or_else(|| "Folder not found".into())
}

fn delete_folder(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM folder_items WHERE folder_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Folder not found".into());
    }
    enqueue_op(conn, json!({ "op": "delete", "id": id }))?;
    Ok(())
}

fn remove_from_folder(conn: &Connection, creation_ids: &[String]) -> Result<(), String> {
    if creation_ids.is_empty() {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let mut folders: Vec<String> = Vec::new();
    for creation_id in creation_ids {
        let mut stmt = conn
            .prepare("SELECT folder_id FROM folder_items WHERE creation_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![creation_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let id = row.map_err(|e| e.to_string())?;
            if !folders.contains(&id) {
                folders.push(id);
            }
        }
        conn.execute(
            "DELETE FROM folder_items WHERE creation_id = ?1",
            params![creation_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for folder_id in folders {
        touch_folder(conn, &folder_id, &now)?;
    }
    let cloud_ids = cloud_creation_ids(creation_ids);
    if !cloud_ids.is_empty() {
        enqueue_op(
            conn,
            json!({
                "op": "move",
                "folder_id": null,
                "creation_ids": cloud_ids,
            }),
        )?;
    }
    Ok(())
}

fn collect_local_only_memberships(
    conn: &Connection,
) -> Result<Vec<(String, String, String)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT folder_id, creation_id, added_at FROM folder_items
             ORDER BY folder_id ASC, added_at ASC, creation_id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (folder_id, creation_id, added_at) = row.map_err(|e| e.to_string())?;
        if is_local_only_creation_id(&creation_id) {
            out.push((folder_id, creation_id, added_at));
        }
    }
    Ok(out)
}

fn pending_create_folder_ids(conn: &Connection) -> Result<std::collections::HashSet<String>, String> {
    let mut out = std::collections::HashSet::new();
    for row in list_pending_ops(conn)? {
        if row.op.get("op").and_then(|v| v.as_str()) != Some("create") {
            continue;
        }
        if let Some(id) = row.op.get("id").and_then(|v| v.as_str()) {
            out.insert(id.to_string());
        }
    }
    Ok(out)
}

fn apply_snapshot(
    conn: &Connection,
    revision: i64,
    folders: &[CloudFolderRow],
) -> Result<Vec<LibraryFolder>, String> {
    let local_only = collect_local_only_memberships(conn)?;
    let preserve_ids = pending_create_folder_ids(conn)?;
    let mut preserved: Vec<LibraryFolder> = Vec::new();
    for id in &preserve_ids {
        if folders.iter().any(|f| f.id == *id) {
            continue;
        }
        if let Some(folder) = get_folder(conn, id)? {
            preserved.push(folder);
        }
    }

    let now = Utc::now().to_rfc3339();

    conn.execute("DELETE FROM folder_items", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders", [])
        .map_err(|e| e.to_string())?;

    for folder in folders {
        let created = folder
            .created_at
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| now.clone());
        let updated = folder
            .updated_at
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| now.clone());
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                folder.id,
                normalize_title(&folder.title),
                folder.description,
                created,
                updated
            ],
        )
        .map_err(|e| e.to_string())?;
        for creation_id in &folder.creation_ids {
            if creation_id.trim().is_empty() || is_local_only_creation_id(creation_id) {
                continue;
            }
            // Unique membership: clear any prior insert for this creation.
            conn.execute(
                "DELETE FROM folder_items WHERE creation_id = ?1",
                params![creation_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO folder_items(folder_id, creation_id, added_at)
                 VALUES (?1, ?2, ?3)",
                params![folder.id, creation_id, &updated],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Keep not-yet-uploaded local creates across snapshot installs.
    for folder in preserved {
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                folder.id,
                folder.title,
                folder.description,
                folder.created_at,
                folder.updated_at
            ],
        )
        .map_err(|e| e.to_string())?;
        for creation_id in &folder.member_ids {
            conn.execute(
                "DELETE FROM folder_items WHERE creation_id = ?1",
                params![creation_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO folder_items(folder_id, creation_id, added_at)
                 VALUES (?1, ?2, ?3)",
                params![folder.id, creation_id, folder.updated_at],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Restore local-only memberships when the target folder still exists.
    for (folder_id, creation_id, added_at) in local_only {
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM folders WHERE id = ?1 LIMIT 1",
                params![folder_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_none() {
            continue;
        }
        conn.execute(
            "DELETE FROM folder_items WHERE creation_id = ?1",
            params![creation_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES (?1, ?2, ?3)",
            params![folder_id, creation_id, added_at],
        )
        .map_err(|e| e.to_string())?;
    }

    write_revision(conn, revision)?;
    write_baseline(conn, folders)?;
    list_folders(conn)
}

fn ack_ops(conn: &Connection, seqs: &[i64]) -> Result<(), String> {
    if seqs.is_empty() {
        return Ok(());
    }
    for seq in seqs {
        conn.execute("DELETE FROM folder_pending_ops WHERE seq = ?1", params![seq])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn replace_pending_ops(conn: &Connection, ops: &[JsonValue]) -> Result<(), String> {
    conn.execute("DELETE FROM folder_pending_ops", [])
        .map_err(|e| e.to_string())?;
    for op in ops {
        enqueue_op(conn, op.clone())?;
    }
    Ok(())
}

fn sync_state(conn: &Connection) -> Result<FolderSyncState, String> {
    Ok(FolderSyncState {
        revision: read_revision(conn)?,
        pending_ops: list_pending_ops(conn)?,
        folders: list_folders(conn)?,
        baseline_folders: read_baseline(conn)?,
    })
}

fn emit_folders_updated(app: &AppHandle, folders: &[LibraryFolder]) {
    let _ = app.emit("library-folders-updated", folders);
}

/// Creation ids that currently belong to any folder.
#[tauri::command]
pub async fn library_list_filed_creation_ids() -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let mut stmt = conn
        .prepare("SELECT creation_id FROM folder_items ORDER BY creation_id ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn library_list_folders() -> Result<Vec<LibraryFolder>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    list_folders(&conn)
}

#[tauri::command]
pub async fn library_get_folder(id: String) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    get_folder(&conn, &id)?.ok_or_else(|| "Folder not found".into())
}

#[tauri::command]
pub async fn library_create_folder(
    title: String,
    creation_ids: Vec<String>,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    create_folder(&conn, &title, &creation_ids)
}

#[tauri::command]
pub async fn library_rename_folder(
    id: String,
    title: String,
    description: String,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    rename_folder(&conn, &id, &title, &description)
}

#[tauri::command]
pub async fn library_add_to_folder(
    folder_id: String,
    creation_ids: Vec<String>,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    if get_folder(&conn, &folder_id)?.is_none() {
        return Err("Folder not found".into());
    }
    let now = Utc::now().to_rfc3339();
    move_creations_into_folder(&conn, &folder_id, &creation_ids, &now)?;
    let cloud_ids = cloud_creation_ids(&creation_ids);
    if !cloud_ids.is_empty() {
        enqueue_op(
            &conn,
            json!({
                "op": "move",
                "folder_id": folder_id,
                "creation_ids": cloud_ids,
            }),
        )?;
    }
    get_folder(&conn, &folder_id)?.ok_or_else(|| "Folder not found".into())
}

#[tauri::command]
pub async fn library_remove_from_folder(creation_ids: Vec<String>) -> Result<(), String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    remove_from_folder(&conn, &creation_ids)
}

#[tauri::command]
pub async fn library_delete_folder(id: String) -> Result<(), String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    delete_folder(&conn, &id)
}

#[tauri::command]
pub async fn library_folder_sync_state() -> Result<FolderSyncState, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    sync_state(&conn)
}

#[tauri::command]
pub async fn library_folders_apply_snapshot(
    app: AppHandle,
    revision: i64,
    folders: Vec<CloudFolderRow>,
) -> Result<FolderSyncState, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let listed = apply_snapshot(&conn, revision, &folders)?;
    emit_folders_updated(&app, &listed);
    sync_state(&conn)
}

#[tauri::command]
pub async fn library_folders_ack_ops(seqs: Vec<i64>) -> Result<FolderSyncState, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    ack_ops(&conn, &seqs)?;
    sync_state(&conn)
}

#[tauri::command]
pub async fn library_folders_set_pending_ops(
    ops: Vec<JsonValue>,
) -> Result<FolderSyncState, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    replace_pending_ops(&conn, &ops)?;
    sync_state(&conn)
}

#[cfg(test)]
mod tests {
    use super::super::paths::{ensure_directories, resolve_paths};
    use super::*;
    use std::env;
    use std::fs;

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let root = env::temp_dir().join(format!(
            "parascene-folders-test-{}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis(),
            Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = resolve_paths(root.clone());
        ensure_directories(&paths).expect("dirs");
        let conn = ready_connection(&paths).expect("conn");
        (conn, root)
    }

    #[test]
    fn create_moves_and_unique_membership() {
        let (conn, root) = temp_conn();
        let a = create_folder(&conn, "A", &["c1".into(), "c2".into()]).expect("create a");
        assert!(is_uuid(&a.id));
        assert_eq!(a.member_count, 2);
        assert_eq!(a.member_ids, vec!["c1".to_string(), "c2".to_string()]);

        let b = create_folder(&conn, "B", &["c2".into()]).expect("create b");
        assert_eq!(b.member_ids, vec!["c2".to_string()]);

        let a2 = get_folder(&conn, &a.id).unwrap().unwrap();
        assert_eq!(a2.member_ids, vec!["c1".to_string()]);

        delete_folder(&conn, &b.id).expect("delete b");
        let filed: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT creation_id FROM folder_items ORDER BY creation_id")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        assert_eq!(filed, vec!["c1".to_string()]);
        let pending = list_pending_ops(&conn).expect("pending");
        assert!(pending.iter().any(|op| op.op["op"] == "create"));
        assert!(pending.iter().any(|op| op.op["op"] == "delete"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn migrates_legacy_ids_and_enqueues_creates() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES ('folder-1-2', 'Legacy', '', 't', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('folder-1-2', '99', 't')",
            [],
        )
        .unwrap();
        // Clear auto first-sync creates from empty DB path; re-run migration.
        conn.execute("DELETE FROM folder_pending_ops", []).unwrap();
        ensure_folder_sync_ready(&conn).expect("migrate");
        let folders = list_folders(&conn).expect("list");
        assert_eq!(folders.len(), 1);
        assert!(is_uuid(&folders[0].id));
        assert_eq!(folders[0].member_ids, vec!["99".to_string()]);
        let pending = list_pending_ops(&conn).expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].op["op"], "create");
        assert_eq!(pending[0].op["creation_ids"], json!([99]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn apply_snapshot_preserves_local_only_memberships() {
        let (conn, root) = temp_conn();
        let folder = create_folder(
            &conn,
            "Mixed",
            &["101".into(), "local-import-1".into()],
        )
        .expect("create");
        let seqs: Vec<i64> = list_pending_ops(&conn)
            .unwrap()
            .into_iter()
            .map(|op| op.seq)
            .collect();
        ack_ops(&conn, &seqs).unwrap();

        let listed = apply_snapshot(
            &conn,
            2,
            &[CloudFolderRow {
                id: folder.id.clone(),
                title: "Mixed".into(),
                description: "".into(),
                created_at: Some(folder.created_at.clone()),
                updated_at: Some(folder.updated_at.clone()),
                creation_ids: vec!["101".into(), "102".into()],
                member_count: 2,
            }],
        )
        .expect("apply");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].member_ids.contains(&"101".to_string()));
        assert!(listed[0].member_ids.contains(&"102".to_string()));
        assert!(listed[0].member_ids.contains(&"local-import-1".to_string()));
        assert_eq!(read_revision(&conn).unwrap(), Some(2));
        let _ = fs::remove_dir_all(&root);
    }
}
