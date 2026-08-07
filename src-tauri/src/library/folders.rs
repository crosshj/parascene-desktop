//! Library folders with durable pending ops for Parascene cloud sync.

use super::catalog::{default_paths, meta_get, meta_set, ready_connection};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter};
use unicode_segmentation::UnicodeSegmentation;
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
    pub kind: String,
    pub project_id: Option<String>,
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
    #[serde(default = "empty_folder_meta")]
    pub meta: JsonValue,
}

fn empty_folder_meta() -> JsonValue {
    json!({})
}

pub(crate) fn project_folder_meta(project_id: &str) -> JsonValue {
    json!({ "parascene_desktop": { "project_id": project_id } })
}

fn project_id_from_meta(meta: &JsonValue) -> Option<&str> {
    meta.get("parascene_desktop")?
        .get("project_id")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
}

fn cloud_meta_for_folder(folder: &LibraryFolder) -> JsonValue {
    folder
        .project_id
        .as_deref()
        .filter(|_| folder.kind == "project")
        .map(project_folder_meta)
        .unwrap_or_else(empty_folder_meta)
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

pub(crate) fn normalize_project_title(title: &str) -> String {
    let title = title.trim();
    let normalized = if title.is_empty() {
        "Untitled project"
    } else {
        title
    };
    normalized.graphemes(true).take(120).collect()
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
    kind: String,
    project_id: Option<String>,
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
        kind,
        project_id,
    })
}

pub(crate) fn get_folder(conn: &Connection, id: &str) -> Result<Option<LibraryFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, created_at, updated_at, kind, project_id
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
        row.get(5).map_err(|e| e.to_string())?,
        row.get(6).map_err(|e| e.to_string())?,
    )?))
}

pub(crate) fn list_folders(conn: &Connection) -> Result<Vec<LibraryFolder>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, created_at, updated_at, kind, project_id
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
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, title, description, created_at, updated_at, kind, project_id) =
            row.map_err(|e| e.to_string())?;
        out.push(folder_from_row(
            conn,
            id,
            title,
            description,
            created_at,
            updated_at,
            kind,
            project_id,
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

pub(crate) fn enqueue_op(conn: &Connection, op: JsonValue) -> Result<(), String> {
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
    let n: i64 = raw
        .trim()
        .parse()
        .map_err(|_| "invalid folder revision".to_string())?;
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
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_id,
                folder.title,
                folder.description,
                folder.created_at,
                folder.updated_at,
                folder.kind,
                folder.project_id,
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
            "meta": cloud_meta_for_folder(&migrated),
        });
        if let Some(project_id) = migrated
            .project_id
            .as_deref()
            .filter(|_| migrated.kind == "project")
        {
            create_op["project_id"] = json!(project_id);
        }
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
                "meta": cloud_meta_for_folder(&folder),
            });
            if let Some(project_id) = folder
                .project_id
                .as_deref()
                .filter(|_| folder.kind == "project")
            {
                create_op["project_id"] = json!(project_id);
            }
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
pub(crate) fn move_creations_into_folder(
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
    ensure_generic_move_is_safe(conn, None, creation_ids)?;
    let title = normalize_title(title);
    let id = new_folder_id();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
         VALUES (?1, ?2, '', ?3, ?3, 'regular', NULL)",
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
    if get_folder(conn, id)?.is_some_and(|folder| folder.kind == "project") {
        return Err("Project folders can only be renamed by renaming their project".into());
    }
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
    if get_folder(conn, id)?.is_some_and(|folder| folder.kind == "project") {
        return Err("Project folders can only be removed by deleting their project".into());
    }
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

/// Drop pending folder ops that target this folder id (as `id` or `folder_id`).
fn scrub_pending_ops_for_folder(conn: &Connection, folder_id: &str) -> Result<(), String> {
    let pending = list_pending_ops(conn)?;
    for row in pending {
        let targets_folder = row
            .op
            .get("id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| id == folder_id)
            || row
                .op
                .get("folder_id")
                .and_then(|v| v.as_str())
                .is_some_and(|id| id == folder_id);
        if !targets_folder {
            continue;
        }
        conn.execute(
            "DELETE FROM folder_pending_ops WHERE seq = ?1",
            params![row.seq],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn meta_clears_project_marker(meta: &JsonValue) -> bool {
    project_id_from_meta(meta).is_none()
}

/// Pending local deletes or marker-clearing updates for a folder id.
fn pending_release_folder_ids(
    conn: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
    let mut out = std::collections::HashSet::new();
    for row in list_pending_ops(conn)? {
        let op = row.op.get("op").and_then(|v| v.as_str()).unwrap_or("");
        let Some(id) = row.op.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if op == "delete" {
            out.insert(id.to_string());
            continue;
        }
        if op == "update" {
            if let Some(meta) = row.op.get("meta") {
                if meta_clears_project_marker(meta) {
                    out.insert(id.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// Convert a marked project folder to a regular folder, keep members, clear cloud marker.
/// Call from Delete project and orphan heal.
pub(crate) fn convert_marked_project_folder_to_regular(
    conn: &Connection,
    project_id: &str,
    folder_id: &str,
) -> Result<LibraryFolder, String> {
    let folder = get_folder(conn, folder_id)?
        .ok_or_else(|| format!("Project folder {folder_id} was not found"))?;
    if folder.kind != "project" || folder.project_id.as_deref() != Some(project_id) {
        return Err(format!(
            "Folder {folder_id} is not the marked folder for project {project_id}"
        ));
    }
    scrub_pending_ops_for_folder(conn, folder_id)?;
    let now = Utc::now().to_rfc3339();
    let n = conn
        .execute(
            "UPDATE folders SET kind = 'regular', project_id = NULL, updated_at = ?1 WHERE id = ?2",
            params![now, folder_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("Folder not found".into());
    }
    enqueue_op(
        conn,
        json!({
            "op": "update",
            "id": folder_id,
            "title": folder.title,
            "description": folder.description,
            "meta": empty_folder_meta(),
        }),
    )?;
    get_folder(conn, folder_id)?.ok_or_else(|| "Folder disappeared after project release".into())
}

/// Convert every project folder that has no local usage revision (orphan / foreign
/// with no document on this device) into a regular folder and queue marker clear.
pub(crate) fn liberate_orphan_project_folders(
    conn: &Connection,
) -> Result<Vec<LibraryFolder>, String> {
    let folders = list_folders(conn)?;
    let mut released = Vec::new();
    for folder in folders {
        if folder.kind != "project" {
            continue;
        }
        let Some(project_id) = folder.project_id.clone() else {
            // Broken marker row: demote without a project_id match check.
            scrub_pending_ops_for_folder(conn, &folder.id)?;
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE folders SET kind = 'regular', project_id = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, folder.id],
            )
            .map_err(|e| e.to_string())?;
            enqueue_op(
                conn,
                json!({
                    "op": "update",
                    "id": folder.id,
                    "title": folder.title,
                    "description": folder.description,
                    "meta": empty_folder_meta(),
                }),
            )?;
            if let Some(updated) = get_folder(conn, &folder.id)? {
                released.push(updated);
            }
            continue;
        };
        if has_local_project_document(conn, &project_id)? {
            continue;
        }
        released.push(convert_marked_project_folder_to_regular(
            conn,
            &project_id,
            &folder.id,
        )?);
    }
    Ok(released)
}

fn remove_from_folder_internal(
    conn: &Connection,
    creation_ids: &[String],
    project_id: Option<&str>,
) -> Result<(), String> {
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
        let mut op = json!({
            "op": "move",
            "folder_id": null,
            "creation_ids": cloud_ids,
        });
        if let Some(project_id) = project_id {
            op["project_id"] = json!(project_id);
        }
        enqueue_op(conn, op)?;
    }
    Ok(())
}

pub(crate) fn remove_from_folder(conn: &Connection, creation_ids: &[String]) -> Result<(), String> {
    remove_from_folder_internal(conn, creation_ids, None)
}

pub(crate) fn remove_from_project_folder(
    conn: &Connection,
    project_id: &str,
    creation_ids: &[String],
) -> Result<(), String> {
    remove_from_folder_internal(conn, creation_ids, Some(project_id))
}

fn ensure_generic_move_is_safe(
    conn: &Connection,
    target_folder_id: Option<&str>,
    creation_ids: &[String],
) -> Result<(), String> {
    if let Some(target) = target_folder_id {
        let target_kind: Option<String> = conn
            .query_row(
                "SELECT kind FROM folders WHERE id = ?1",
                params![target],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if target_kind.as_deref() == Some("project") {
            return Err("Use Add to project to file creations into a project folder".into());
        }
    }
    for creation_id in creation_ids {
        let source: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT f.kind, f.project_id
                 FROM folder_items fi JOIN folders f ON f.id = fi.folder_id
                 WHERE fi.creation_id = ?1 LIMIT 1",
                params![creation_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((kind, project_id)) = source {
            if kind == "project" {
                return Err(format!(
                    "Creation {creation_id} belongs to project {}. Use Remove from project first.",
                    project_id.unwrap_or_else(|| "(unknown)".into())
                ));
            }
        }
    }
    Ok(())
}

fn pending_create_folder_ids(
    conn: &Connection,
) -> Result<std::collections::HashSet<String>, String> {
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

fn has_local_project_document(conn: &Connection, project_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_usage_revisions WHERE project_id = ?1)",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn apply_snapshot(
    conn: &Connection,
    revision: i64,
    folders: &[CloudFolderRow],
) -> Result<Vec<LibraryFolder>, String> {
    let mut seen_folder_ids = std::collections::HashSet::new();
    let mut remote_membership = std::collections::HashMap::<&str, &str>::new();
    for folder in folders {
        if folder.id.trim().is_empty() || !seen_folder_ids.insert(folder.id.as_str()) {
            return Err(format!(
                "Remote folder snapshot contains an empty or duplicate folder id: {}",
                folder.id
            ));
        }
        for creation_id in &folder.creation_ids {
            let id = creation_id.trim();
            if id.is_empty() || is_local_only_creation_id(id) {
                continue;
            }
            if let Some(existing_folder_id) = remote_membership.insert(id, folder.id.as_str()) {
                if existing_folder_id != folder.id {
                    return Err(format!(
                        "Remote folder snapshot files creation {id} in both {existing_folder_id} and {}",
                        folder.id
                    ));
                }
            }
        }
    }
    let preserve_ids = pending_create_folder_ids(conn)?;
    let release_ids = pending_release_folder_ids(conn)?;
    let remote_ids: std::collections::HashSet<&str> =
        folders.iter().map(|folder| folder.id.as_str()).collect();
    let now = Utc::now().to_rfc3339();
    let transaction = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Remove only ordinary cloud folders that disappeared. Project roots and
    // pending local creates are never erased by a snapshot.
    for local in list_folders(&transaction)? {
        if remote_ids.contains(local.id.as_str()) || preserve_ids.contains(&local.id) {
            continue;
        }
        // Pending marker release keeps the local regular folder until upload acks.
        if release_ids.contains(&local.id) {
            continue;
        }
        let locally_owned_project = if local.kind == "project" {
            match local.project_id.as_deref() {
                Some(project_id) => has_local_project_document(&transaction, project_id)?,
                None => false,
            }
        } else {
            false
        };
        if locally_owned_project {
            if !preserve_ids.contains(&local.id) {
                let mut op = json!({
                    "op": "create",
                    "id": local.id,
                    "title": local.title,
                    "description": local.description,
                    "meta": cloud_meta_for_folder(&local),
                });
                if let Some(project_id) = local.project_id.as_deref() {
                    op["project_id"] = json!(project_id);
                }
                let cloud_ids = cloud_creation_ids(&local.member_ids);
                if !cloud_ids.is_empty() {
                    op["creation_ids"] = json!(cloud_ids);
                }
                enqueue_op(&transaction, op)?;
            }
            continue;
        }
        transaction
            .execute(
                "DELETE FROM folder_items WHERE folder_id = ?1",
                params![local.id],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute("DELETE FROM folders WHERE id = ?1", params![local.id])
            .map_err(|e| e.to_string())?;
    }

    for folder in folders {
        let pending_release = release_ids.contains(&folder.id);
        let remote_project_id = if pending_release {
            // Local delete/release wins until the pending op is acknowledged.
            None
        } else {
            project_id_from_meta(&folder.meta)
        };
        let remote_kind = if remote_project_id.is_some() {
            "project"
        } else {
            "regular"
        };
        let existing = get_folder(&transaction, &folder.id)?;
        // Do not resurrect a folder that this client already queued for delete.
        if pending_release && existing.is_none() {
            let is_pending_delete = list_pending_ops(&transaction)?.iter().any(|row| {
                row.op.get("op").and_then(|v| v.as_str()) == Some("delete")
                    && row.op.get("id").and_then(|v| v.as_str()) == Some(folder.id.as_str())
            });
            if is_pending_delete {
                continue;
            }
        }
        let existing_owned_project = match existing.as_ref() {
            Some(local) if local.kind == "project" => match local.project_id.as_deref() {
                Some(project_id) => has_local_project_document(&transaction, project_id)?,
                None => false,
            },
            _ => false,
        };
        if let Some(local) = existing.as_ref().filter(|row| row.kind == "project") {
            if remote_project_id.is_some() && local.project_id.as_deref() != remote_project_id {
                return Err(format!(
                    "Folder {} has conflicting project identities (local {}, remote {})",
                    folder.id,
                    local.project_id.as_deref().unwrap_or("missing"),
                    remote_project_id.unwrap_or("missing")
                ));
            }
            let local_project_id = local.project_id.as_deref().unwrap_or("");
            // A local project document owns title and repairs a missing cloud marker.
            if existing_owned_project
                && (local.title != normalize_project_title(&folder.title)
                    || remote_project_id != Some(local_project_id))
            {
                enqueue_op(
                    &transaction,
                    json!({
                        "op": "update",
                        "id": local.id,
                        "title": local.title,
                        "description": local.description,
                        "meta": project_folder_meta(local_project_id),
                        "project_id": local_project_id,
                    }),
                )?;
            }
        } else if let Some(remote_project_id) = remote_project_id {
            let owner_folder: Option<String> = transaction
                .query_row(
                    "SELECT id FROM folders WHERE project_id = ?1 AND id != ?2 LIMIT 1",
                    params![remote_project_id, folder.id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some(owner_folder) = owner_folder {
                return Err(format!(
                    "Project {remote_project_id} is claimed by both {owner_folder} and {}",
                    folder.id
                ));
            }
        }
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
        if existing_owned_project {
            // The project document owns title; keep the synced description only.
            transaction
                .execute(
                    "UPDATE folders SET description = ?1 WHERE id = ?2",
                    params![folder.description, folder.id],
                )
                .map_err(|e| e.to_string())?;
        } else if pending_release {
            // Keep or install as regular; never re-adopt the remote project marker.
            transaction
                .execute(
                    "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'regular', NULL)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title,
                       description = excluded.description, updated_at = excluded.updated_at,
                       kind = 'regular', project_id = NULL",
                    params![
                        folder.id,
                        normalize_title(&folder.title),
                        folder.description,
                        created,
                        updated,
                    ],
                )
                .map_err(|e| e.to_string())?;
        } else {
            transaction
                .execute(
                    "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET title = excluded.title,
                       description = excluded.description, updated_at = excluded.updated_at,
                       kind = excluded.kind, project_id = excluded.project_id",
                    params![
                        folder.id,
                        if remote_kind == "project" {
                            normalize_project_title(&folder.title)
                        } else {
                            normalize_title(&folder.title)
                        },
                        folder.description,
                        created,
                        updated,
                        remote_kind,
                        if remote_kind == "project" {
                            remote_project_id
                        } else {
                            None
                        },
                    ],
                )
                .map_err(|e| e.to_string())?;
        }

        let target = get_folder(&transaction, &folder.id)?
            .ok_or_else(|| format!("Folder {} disappeared during snapshot", folder.id))?;
        let remote_members: std::collections::HashSet<&str> = folder
            .creation_ids
            .iter()
            .map(|id| id.as_str())
            .filter(|id| !id.trim().is_empty() && !is_local_only_creation_id(id))
            .collect();

        // Remote removal from a project folder is accepted only with a ready,
        // unused project index. Otherwise retain and queue a corrective move.
        for current_id in target
            .member_ids
            .iter()
            .filter(|id| !is_local_only_creation_id(id))
        {
            if remote_members.contains(current_id.as_str()) {
                continue;
            }
            let safe_to_release = if target.kind != "project" {
                true
            } else if let Some(project_id) = target.project_id.as_deref() {
                if !has_local_project_document(&transaction, project_id)? {
                    true
                } else {
                    let state: Option<String> = transaction
                        .query_row(
                            "SELECT state FROM project_usage_revisions WHERE project_id = ?1",
                            params![project_id],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    let uses: i64 = transaction
                        .query_row(
                            "SELECT COUNT(*) FROM project_asset_usage
                         WHERE project_id = ?1 AND creation_id = ?2",
                            params![project_id, current_id],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    state.as_deref() == Some("ready") && uses == 0
                }
            } else {
                false
            };
            if safe_to_release {
                transaction
                    .execute(
                        "DELETE FROM folder_items WHERE folder_id = ?1 AND creation_id = ?2",
                        params![folder.id, current_id],
                    )
                    .map_err(|e| e.to_string())?;
            } else {
                let cloud_ids = cloud_creation_ids(std::slice::from_ref(current_id));
                if !cloud_ids.is_empty() {
                    enqueue_op(
                        &transaction,
                        json!({
                            "op": "move",
                            "folder_id": folder.id,
                            "creation_ids": cloud_ids,
                            "project_id": target.project_id.as_deref(),
                        }),
                    )?;
                }
            }
        }

        for creation_id in &folder.creation_ids {
            if creation_id.trim().is_empty() || is_local_only_creation_id(creation_id) {
                continue;
            }
            let source: Option<(String, String, Option<String>)> = transaction
                .query_row(
                    "SELECT f.id, f.kind, f.project_id
                     FROM folder_items fi JOIN folders f ON f.id = fi.folder_id
                     WHERE fi.creation_id = ?1 LIMIT 1",
                    params![creation_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((source_id, source_kind, source_project_id)) = source.as_ref() {
                if source_id != &folder.id && source_kind == "project" {
                    let locally_owned = match source_project_id.as_deref() {
                        Some(project_id) => has_local_project_document(&transaction, project_id)?,
                        None => false,
                    };
                    if !locally_owned {
                        // This machine has no matching project document, so the
                        // cloud owner is authoritative for membership changes.
                    } else {
                        let ready: Option<String> = transaction
                            .query_row(
                                "SELECT state FROM project_usage_revisions WHERE project_id = ?1",
                                params![source_project_id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|e| e.to_string())?;
                        let uses: i64 = transaction
                            .query_row(
                                "SELECT COUNT(*) FROM project_asset_usage
                             WHERE project_id = ?1 AND creation_id = ?2",
                                params![source_project_id, creation_id],
                                |row| row.get(0),
                            )
                            .map_err(|e| e.to_string())?;
                        if ready.as_deref() != Some("ready") || uses > 0 {
                            let cloud_ids = cloud_creation_ids(std::slice::from_ref(creation_id));
                            enqueue_op(
                                &transaction,
                                json!({
                                    "op": "move",
                                    "folder_id": source_id,
                                    "creation_ids": cloud_ids,
                                    "project_id": source_project_id.as_deref(),
                                }),
                            )?;
                            continue;
                        }
                    }
                }
            }
            transaction
                .execute(
                    "DELETE FROM folder_items WHERE creation_id = ?1",
                    params![creation_id],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "INSERT INTO folder_items(folder_id, creation_id, added_at)
                 VALUES (?1, ?2, ?3)",
                    params![folder.id, creation_id, &updated],
                )
                .map_err(|e| e.to_string())?;
        }
    }

    // `folder_items` is the only project-membership authority. Keep the
    // one-release compatibility cache derived, including source projects that
    // lost a member to a remote move.
    for project_folder in list_folders(&transaction)?
        .into_iter()
        .filter(|folder| folder.kind == "project")
    {
        let Some(project_id) = project_folder.project_id.as_deref() else {
            continue;
        };
        if !has_local_project_document(&transaction, project_id)? {
            continue;
        }
        let mut stmt = transaction
            .prepare(
                "SELECT creation_id FROM project_assets WHERE project_id = ?1 ORDER BY creation_id",
            )
            .map_err(|e| e.to_string())?;
        let cached = stmt
            .query_map(params![project_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        drop(stmt);
        let mut canonical = project_folder.member_ids.clone();
        canonical.sort();
        if cached == canonical {
            continue;
        }
        // A destructive remote membership change has committed before the
        // localStorage project mirror can be updated. Keep project edits and
        // removals fail-closed until the folder event persists that mirror.
        transaction
            .execute(
                "UPDATE project_usage_revisions SET state = 'stale', indexed_at = NULL
                 WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|e| e.to_string())?;
        transaction
            .execute(
                "DELETE FROM project_assets WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(|e| e.to_string())?;
        for creation_id in &project_folder.member_ids {
            transaction
                .execute(
                    "INSERT INTO project_assets(project_id, creation_id, added_at) VALUES (?1, ?2, ?3)",
                    params![project_id, creation_id, now],
                )
                .map_err(|e| e.to_string())?;
        }
        transaction
            .execute(
                "INSERT INTO project_membership_revisions(project_id, revision) VALUES (?1, 1)
                 ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1",
                params![project_id],
            )
            .map_err(|e| e.to_string())?;
    }

    write_revision(&transaction, revision)?;
    write_baseline(&transaction, folders)?;
    transaction.commit().map_err(|e| e.to_string())?;
    list_folders(conn)
}

fn ack_ops(conn: &Connection, seqs: &[i64]) -> Result<(), String> {
    if seqs.is_empty() {
        return Ok(());
    }
    for seq in seqs {
        conn.execute(
            "DELETE FROM folder_pending_ops WHERE seq = ?1",
            params![seq],
        )
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

pub(crate) fn emit_folders_updated(app: &AppHandle, folders: &[LibraryFolder]) {
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
    app: AppHandle,
    title: String,
    creation_ids: Vec<String>,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let folder = create_folder(&conn, &title, &creation_ids)?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(folder)
}

#[tauri::command]
pub async fn library_rename_folder(
    app: AppHandle,
    id: String,
    title: String,
    description: String,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let folder = rename_folder(&conn, &id, &title, &description)?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(folder)
}

#[tauri::command]
pub async fn library_add_to_folder(
    app: AppHandle,
    folder_id: String,
    creation_ids: Vec<String>,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    if get_folder(&conn, &folder_id)?.is_none() {
        return Err("Folder not found".into());
    }
    ensure_generic_move_is_safe(&conn, Some(&folder_id), &creation_ids)?;
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
    let folder = get_folder(&conn, &folder_id)?.ok_or_else(|| String::from("Folder not found"))?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(folder)
}

#[tauri::command]
pub async fn library_remove_from_folder(
    app: AppHandle,
    creation_ids: Vec<String>,
) -> Result<(), String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    ensure_generic_move_is_safe(&conn, None, &creation_ids)?;
    remove_from_folder(&conn, &creation_ids)?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(())
}

#[tauri::command]
pub async fn library_delete_folder(app: AppHandle, id: String) -> Result<(), String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    delete_folder(&conn, &id)?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(())
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
        let folder = create_folder(&conn, "Mixed", &["101".into(), "local-import-1".into()])
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
                meta: json!({}),
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

    #[test]
    fn generic_folder_actions_cannot_mutate_project_roots_or_members() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('project-folder', 'Project One', '', 't', 't', 'project', 'project-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('project-folder', '101', 't')",
            [],
        )
        .unwrap();

        assert!(rename_folder(&conn, "project-folder", "Renamed", "").is_err());
        assert!(delete_folder(&conn, "project-folder").is_err());
        assert!(
            ensure_generic_move_is_safe(&conn, Some("project-folder"), &["202".into()],).is_err()
        );
        assert!(ensure_generic_move_is_safe(&conn, None, &["101".into()]).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_preserves_missing_project_root_and_used_membership() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('project-folder', 'Project One', '', 't', 't', 'project', 'project-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('project-folder', '101', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
             VALUES ('project-1', 'doc-1', 'ready', 't')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_asset_usage(
               project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label, document_revision
             ) VALUES ('project-1', '101', 'timeline_clip', 'clip-1', 'Opening clip', 'doc-1')",
            [],
        )
        .unwrap();

        let listed = apply_snapshot(&conn, 2, &[]).expect("missing remote project root");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "project");
        assert_eq!(listed[0].project_id.as_deref(), Some("project-1"));
        assert_eq!(listed[0].member_ids, vec!["101".to_string()]);
        assert!(list_pending_ops(&conn).unwrap().iter().any(|row| {
            row.op["op"] == "create"
                && row.op["project_id"] == "project-1"
                && row.op["meta"] == project_folder_meta("project-1")
        }));

        let listed = apply_snapshot(
            &conn,
            3,
            &[CloudFolderRow {
                id: "project-folder".into(),
                title: "Remote rename".into(),
                description: "".into(),
                created_at: Some("t".into()),
                updated_at: Some("t2".into()),
                creation_ids: vec![],
                member_count: 0,
                meta: project_folder_meta("project-1"),
            }],
        )
        .expect("used remote removal");
        assert_eq!(listed[0].title, "Project One");
        assert_eq!(listed[0].member_ids, vec!["101".to_string()]);
        assert!(list_pending_ops(&conn).unwrap().iter().any(|row| {
            row.op["op"] == "move"
                && row.op["folder_id"] == "project-folder"
                && row.op["creation_ids"] == json!([101])
                && row.op["project_id"] == "project-1"
        }));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn remote_project_marker_is_locked_but_cloud_owned_without_local_document() {
        let (conn, root) = temp_conn();
        let first = CloudFolderRow {
            id: "remote-project-folder".into(),
            title: "Project elsewhere".into(),
            description: "".into(),
            created_at: Some("t".into()),
            updated_at: Some("t".into()),
            creation_ids: vec!["101".into()],
            member_count: 1,
            meta: project_folder_meta("remote-project"),
        };
        let listed = apply_snapshot(&conn, 1, &[first.clone()]).expect("first snapshot");
        assert_eq!(listed[0].kind, "project");
        assert_eq!(listed[0].project_id.as_deref(), Some("remote-project"));
        assert!(ensure_generic_move_is_safe(&conn, None, &["101".into()]).is_err());

        let mut second = first;
        second.title = "Renamed elsewhere".into();
        second.creation_ids.clear();
        second.member_count = 0;
        let listed = apply_snapshot(&conn, 2, &[second]).expect("owner snapshot");
        assert_eq!(listed[0].title, "Renamed elsewhere");
        assert!(listed[0].member_ids.is_empty());
        assert!(list_pending_ops(&conn).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_rejects_duplicate_remote_membership() {
        let (conn, root) = temp_conn();
        let folder = |id: &str| CloudFolderRow {
            id: id.into(),
            title: id.into(),
            description: "".into(),
            created_at: Some("t".into()),
            updated_at: Some("t".into()),
            creation_ids: vec!["101".into()],
            member_count: 1,
            meta: json!({}),
        };

        let error = apply_snapshot(&conn, 2, &[folder("one"), folder("two")])
            .expect_err("duplicate membership must fail closed");
        assert!(error.contains("both one and two"));
        assert!(list_folders(&conn).unwrap().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn project_title_contract_uses_project_fallback_and_graphemes() {
        assert_eq!(normalize_project_title("  "), "Untitled project");
        let family = "👨‍👩‍👧‍👦";
        assert_eq!(
            normalize_project_title(&family.repeat(121)),
            family.repeat(120)
        );
    }

    #[test]
    fn convert_marked_project_folder_keeps_members_and_clears_marker() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('project-folder', 'Text Meme', '', 't', 't', 'project', 'project-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('project-folder', '101', 't'), ('project-folder', '102', 't')",
            [],
        )
        .unwrap();
        enqueue_op(
            &conn,
            json!({ "op": "update", "id": "project-folder", "title": "stale" }),
        )
        .unwrap();

        let released =
            convert_marked_project_folder_to_regular(&conn, "project-1", "project-folder")
                .expect("convert");
        assert_eq!(released.kind, "regular");
        assert!(released.project_id.is_none());
        assert_eq!(released.member_ids, vec!["101".to_string(), "102".to_string()]);
        let pending = list_pending_ops(&conn).expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].op["op"], "update");
        assert_eq!(pending[0].op["id"], "project-folder");
        assert_eq!(pending[0].op["meta"], json!({}));
        assert!(pending[0].op.get("title").is_some());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_honors_pending_release_instead_of_resurrecting_project() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES ('project-folder', 'Text Meme', '', 't', 't', 'regular', NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO folder_items(folder_id, creation_id, added_at)
             VALUES ('project-folder', '101', 't')",
            [],
        )
        .unwrap();
        enqueue_op(
            &conn,
            json!({
                "op": "update",
                "id": "project-folder",
                "title": "Text Meme",
                "description": "",
                "meta": {},
            }),
        )
        .unwrap();

        let listed = apply_snapshot(
            &conn,
            2,
            &[CloudFolderRow {
                id: "project-folder".into(),
                title: "Untitled project".into(),
                description: "".into(),
                created_at: Some("t".into()),
                updated_at: Some("t2".into()),
                creation_ids: vec!["101".into(), "102".into()],
                member_count: 2,
                meta: project_folder_meta("project-1"),
            }],
        )
        .expect("snapshot with pending release");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "regular");
        assert!(listed[0].project_id.is_none());
        assert_eq!(listed[0].title, "Untitled project");
        assert!(list_pending_ops(&conn).unwrap().iter().any(|row| {
            row.op["op"] == "update" && row.op["meta"] == json!({})
        }));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_does_not_resurrect_pending_deleted_project_folder() {
        let (conn, root) = temp_conn();
        enqueue_op(
            &conn,
            json!({
                "op": "delete",
                "id": "project-folder",
                "project_id": "project-1",
            }),
        )
        .unwrap();

        let listed = apply_snapshot(
            &conn,
            2,
            &[CloudFolderRow {
                id: "project-folder".into(),
                title: "Untitled project".into(),
                description: "".into(),
                created_at: Some("t".into()),
                updated_at: Some("t".into()),
                creation_ids: vec!["101".into()],
                member_count: 1,
                meta: project_folder_meta("project-1"),
            }],
        )
        .expect("snapshot with pending delete");
        assert!(listed.is_empty());
        assert!(get_folder(&conn, "project-folder").unwrap().is_none());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn liberate_converts_orphan_project_folder_but_keeps_owned() {
        let (conn, root) = temp_conn();
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
             VALUES
               ('orphan-folder', 'Orphan', '', 't', 't', 'project', 'orphan-1'),
               ('owned-folder', 'Owned', '', 't', 't', 'project', 'owned-1')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
             VALUES ('owned-1', 'doc-1', 'ready', 't')",
            [],
        )
        .unwrap();

        let released = liberate_orphan_project_folders(&conn).expect("liberate");
        assert_eq!(released.len(), 1);
        assert_eq!(released[0].id, "orphan-folder");
        assert_eq!(released[0].kind, "regular");

        let owned = get_folder(&conn, "owned-folder").unwrap().unwrap();
        assert_eq!(owned.kind, "project");
        assert_eq!(owned.project_id.as_deref(), Some("owned-1"));

        let _ = fs::remove_dir_all(&root);
    }
}
