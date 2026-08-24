use super::catalog::{
    clear_native_project_index, default_paths, delete_creation_local,
    prune_stale_creation_usage, ready_connection, sync_status_for, SyncStatus,
};
use super::folders::{
    cloud_meta_for_folder, convert_marked_project_folder_to_regular, emit_folders_updated,
    enqueue_op, get_folder, liberate_orphan_project_folders, list_folders,
    move_creations_into_folder, normalize_project_title, project_folder_meta, remove_from_folder,
    remove_from_project_folder, LibraryFolder,
};
use super::import_local::{import_paths, ImportLocalResult};
use super::parascene_api::group_member_ids;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetUsageInput {
    pub creation_id: String,
    pub usage_kind: String,
    pub usage_owner_id: String,
    pub usage_owner_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetUsageBlocker {
    pub project_id: String,
    pub creation_id: String,
    pub usage_kind: String,
    pub usage_owner_id: String,
    pub usage_owner_label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderBlockerGroup {
    pub folder_id: Option<String>,
    pub folder_title: String,
    pub project_id: Option<String>,
    pub creation_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderReconcileResult {
    pub status: String,
    pub folder: Option<LibraryFolder>,
    pub resolution: Option<String>,
    pub blockers: Vec<ProjectFolderBlockerGroup>,
    pub missing_creation_ids: Vec<String>,
    pub binding_problem: Option<String>,
    pub membership_revision: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAssetMutationResult {
    pub folder: LibraryFolder,
    pub membership_revision: i64,
    pub missing_creation_ids: Vec<String>,
}

fn project_folder(conn: &Connection, project_id: &str) -> Result<Option<LibraryFolder>, String> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM folders WHERE kind = 'project' AND project_id = ?1 LIMIT 1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    id.map(|id| get_folder(conn, &id))
        .transpose()
        .map(|folder| folder.flatten())
}

fn required_project_folder(conn: &Connection, project_id: &str) -> Result<LibraryFolder, String> {
    project_folder(conn, project_id)?.ok_or_else(|| {
        format!("Project {project_id} does not have a ready project folder. Reopen the project to repair it.")
    })
}

fn require_local_project_document(conn: &Connection, project_id: &str) -> Result<(), String> {
    let known: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_usage_revisions WHERE project_id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if known {
        Ok(())
    } else {
        Err(format!(
            "Project {project_id} is unavailable on this device and cannot be modified"
        ))
    }
}

fn replace_project_asset_cache(
    conn: &Connection,
    project_id: &str,
    creation_ids: &[String],
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM project_assets WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    for creation_id in creation_ids {
        conn.execute(
            "INSERT INTO project_assets(project_id, creation_id, added_at) VALUES (?1, ?2, ?3)",
            params![project_id, creation_id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn increment_membership_revision(conn: &Connection, project_id: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO project_membership_revisions(project_id, revision) VALUES (?1, 1)
         ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT revision FROM project_membership_revisions WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn mark_membership_mirror_stale(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE project_usage_revisions SET state = 'stale', indexed_at = NULL
         WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn queue_cloud_move(
    conn: &Connection,
    folder_id: Option<&str>,
    ids: &[String],
    project_id: Option<&str>,
) -> Result<(), String> {
    let cloud_ids: Vec<i64> = ids
        .iter()
        .filter_map(|id| id.trim().parse::<i64>().ok())
        .filter(|id| *id > 0)
        .collect();
    if cloud_ids.is_empty() {
        return Ok(());
    }
    let mut op = json!({ "op": "move", "folder_id": folder_id, "creation_ids": cloud_ids });
    if let Some(project_id) = project_id {
        op["project_id"] = json!(project_id);
    }
    enqueue_op(conn, op)
}

fn create_marked_project_folder(
    conn: &Connection,
    project_id: &str,
    title: &str,
) -> Result<LibraryFolder, String> {
    if let Some(folder) = project_folder(conn, project_id)? {
        let title = normalize_project_title(title);
        if folder.title == title {
            return Ok(folder);
        }
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE folders SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, now, folder.id],
        )
        .map_err(|e| e.to_string())?;
        enqueue_op(
            conn,
            json!({
                "op": "update",
                "id": folder.id,
                "title": title,
                "description": folder.description,
                "meta": cloud_meta_for_folder(&LibraryFolder {
                    title: title.clone(),
                    ..folder.clone()
                }),
                "project_id": project_id,
            }),
        )?;
        return get_folder(conn, &folder.id)?
            .ok_or_else(|| "Project folder disappeared after title repair".into());
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let title = normalize_project_title(title);
    conn.execute(
        "INSERT INTO folders(id, title, description, created_at, updated_at, kind, project_id)
         VALUES (?1, ?2, '', ?3, ?3, 'project', ?4)",
        params![id, title, now, project_id],
    )
    .map_err(|e| e.to_string())?;
    enqueue_op(
        conn,
        json!({
            "op": "create",
            "id": id,
            "title": title,
            "description": "",
            "meta": project_folder_meta(project_id),
            "project_id": project_id,
        }),
    )?;
    get_folder(conn, &id)?.ok_or_else(|| "Project folder disappeared after create".into())
}

fn claim_regular_folder(
    conn: &Connection,
    folder_id: &str,
    project_id: &str,
    title: &str,
) -> Result<LibraryFolder, String> {
    let existing = get_folder(conn, folder_id)?.ok_or_else(|| "Folder not found".to_string())?;
    if existing.kind == "project" && existing.project_id.as_deref() != Some(project_id) {
        return Err(format!(
            "Folder is owned by project {}",
            existing.project_id.unwrap_or_default()
        ));
    }
    let now = Utc::now().to_rfc3339();
    let title = normalize_project_title(title);
    conn.execute(
        "UPDATE folders SET title = ?1, kind = 'project', project_id = ?2, updated_at = ?3
         WHERE id = ?4",
        params![title, project_id, now, folder_id],
    )
    .map_err(|e| e.to_string())?;
    enqueue_op(
        conn,
        json!({
            "op": "update",
            "id": folder_id,
            "project_id": project_id,
            "title": title,
            "description": existing.description,
            "meta": cloud_meta_for_folder(&LibraryFolder {
                title: title.clone(),
                kind: "project".into(),
                project_id: Some(project_id.to_string()),
                ..existing
            }),
        }),
    )?;
    get_folder(conn, folder_id)?.ok_or_else(|| "Project folder disappeared after claim".into())
}

fn creation_location(
    conn: &Connection,
    paths: &super::paths::ParascenePaths,
    creation_id: &str,
) -> Result<Option<Option<String>>, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM creations WHERE id = ?1)",
            params![creation_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(None);
    }
    // A stale membership can hide a creation from the Library root while
    // pointing at a folder that no longer exists. It is not a real conflict.
    conn.execute(
        "DELETE FROM folder_items
         WHERE creation_id = ?1
           AND NOT EXISTS (SELECT 1 FROM folders WHERE folders.id = folder_items.folder_id)",
        params![creation_id],
    )
    .map_err(|e| e.to_string())?;
    let (folder, local_path): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT (
                 SELECT fi.folder_id
                 FROM folder_items fi
                 JOIN folders f ON f.id = fi.folder_id
                 WHERE fi.creation_id = ?1
                 LIMIT 1
             ), local_path FROM creations WHERE id = ?1",
            params![creation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let Some(local_path) = local_path.filter(|path| !path.trim().is_empty()) else {
        return Ok(None);
    };
    let path = PathBuf::from(&local_path);
    let candidate = if path.is_absolute() {
        path
    } else {
        paths.root.join(path)
    };
    if !candidate.is_file() {
        return Ok(None);
    }
    if folder.is_some() {
        return Ok(Some(folder));
    }

    // Group members are intentionally hidden from the Library home grid, but
    // they inherit their effective location from the group cover. Treating
    // them as root assets creates false legacy project conflicts.
    let mut stmt = conn
        .prepare(
            "SELECT id, remote_json FROM creations
             WHERE instr(COALESCE(remote_json, ''), '\"kind\":\"group_creations\"') > 0
                OR instr(COALESCE(remote_json, ''), '\"kind\": \"group_creations\"') > 0",
        )
        .map_err(|e| e.to_string())?;
    let covers = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for cover in covers {
        let (cover_id, raw) = cover.map_err(|e| e.to_string())?;
        let Some(raw) = raw else { continue };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
        let group = value
            .get("meta")
            .and_then(|meta| meta.get("group"))
            .or_else(|| value.get("group"));
        let Some(group) = group else { continue };
        let value_id = |value: &Value| match value {
            Value::String(value) => value.trim().to_string(),
            Value::Number(value) => value.to_string(),
            _ => String::new(),
        };
        let listed = group
            .get("source_creation_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|value| value_id(value) == creation_id);
        let embedded = group
            .get("source_creations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|value| {
                value
                    .get("id")
                    .map(value_id)
                    .is_some_and(|value| value == creation_id)
            });
        if !listed && !embedded {
            continue;
        }
        let cover_folder: Option<String> = conn
            .query_row(
                "SELECT fi.folder_id FROM folder_items fi
                 JOIN folders f ON f.id = fi.folder_id
                 WHERE fi.creation_id = ?1 LIMIT 1",
                params![cover_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        // Effective location for legacy conflict detection only — do not
        // INSERT the member into folder_items (cover-only filing).
        return Ok(Some(cover_folder));
    }
    Ok(Some(None))
}

fn blocker_result(
    conn: &Connection,
    locations: &BTreeMap<Option<String>, Vec<String>>,
    missing: Vec<String>,
    binding_problem: Option<String>,
) -> Result<ProjectFolderReconcileResult, String> {
    let mut blockers = Vec::new();
    for (folder_id, creation_ids) in locations {
        let (title, owner) = match folder_id {
            Some(id) => match get_folder(conn, id)? {
                Some(folder) => (folder.title, folder.project_id),
                None => ("Missing folder".into(), None),
            },
            None => ("Library root".into(), None),
        };
        blockers.push(ProjectFolderBlockerGroup {
            folder_id: folder_id.clone(),
            folder_title: title,
            project_id: owner,
            creation_ids: creation_ids.clone(),
        });
    }
    Ok(ProjectFolderReconcileResult {
        status: "blocked".into(),
        folder: None,
        resolution: None,
        blockers,
        missing_creation_ids: missing,
        binding_problem,
        membership_revision: None,
    })
}

fn finish_reconcile(
    conn: &Connection,
    project_id: &str,
    folder: LibraryFolder,
    resolution: &str,
) -> Result<ProjectFolderReconcileResult, String> {
    let mut cached_stmt = conn
        .prepare(
            "SELECT creation_id FROM project_assets WHERE project_id = ?1 ORDER BY creation_id",
        )
        .map_err(|e| e.to_string())?;
    let cached = cached_stmt
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(cached_stmt);
    let mut canonical = folder.member_ids.clone();
    canonical.sort();
    let membership_mirror_changed = cached != canonical;
    replace_project_asset_cache(conn, project_id, &folder.member_ids)?;
    conn.execute(
        "DELETE FROM project_library_bindings WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    if membership_mirror_changed {
        mark_membership_mirror_stale(conn, project_id)?;
    }
    let membership_revision = increment_membership_revision(conn, project_id)?;
    Ok(ProjectFolderReconcileResult {
        status: "ready".into(),
        folder: Some(folder),
        resolution: Some(resolution.into()),
        blockers: Vec::new(),
        missing_creation_ids: Vec::new(),
        binding_problem: None,
        membership_revision: Some(membership_revision),
    })
}

#[tauri::command]
pub fn library_reconcile_legacy_project_folder(
    app: AppHandle,
    project_id: String,
    title: String,
    bound_folder_ids: Vec<String>,
    legacy_asset_ids: Vec<String>,
) -> Result<ProjectFolderReconcileResult, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    // Repair orphaned memberships before the reconciliation transaction. If
    // the project is still blocked by a real multi-folder conflict, this
    // cleanup must remain committed so the Library can show those creations
    // at root instead of hiding them behind dead folder IDs.
    conn.execute(
        "DELETE FROM folder_items
         WHERE NOT EXISTS (SELECT 1 FROM folders WHERE folders.id = folder_items.folder_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;

    if let Some(marked) = project_folder(&transaction, project_id)? {
        let mut referenced: BTreeSet<String> = legacy_asset_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        referenced.extend(marked.member_ids.iter().cloned());
        let mut missing = Vec::new();
        let mut root_ids = Vec::new();
        for id in referenced {
            match creation_location(&transaction, &paths, &id)? {
                None => missing.push(id),
                Some(None) => root_ids.push(id),
                Some(Some(folder_id)) if folder_id != marked.id => {
                    // Leave assets in another folder untouched; the canonical
                    // project folder remains authoritative for its own members.
                }
                Some(Some(_)) => {}
            }
        }
        let canonical_title = normalize_project_title(&title);
        let folder = if marked.title != canonical_title {
            let now = Utc::now().to_rfc3339();
            transaction
                .execute(
                    "UPDATE folders SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![canonical_title, now, marked.id],
                )
                .map_err(|e| e.to_string())?;
            enqueue_op(
                &transaction,
                json!({
                    "op": "update",
                    "id": marked.id,
                    "title": canonical_title,
                    "description": marked.description,
                    "meta": cloud_meta_for_folder(&LibraryFolder {
                        title: canonical_title.clone(),
                        ..marked.clone()
                    }),
                    "project_id": project_id,
                }),
            )?;
            get_folder(&transaction, &marked.id)?
                .ok_or_else(|| "Marked project folder disappeared".to_string())?
        } else {
            marked
        };
        if !root_ids.is_empty() {
            move_creations_into_folder(
                &transaction,
                &folder.id,
                &root_ids,
                &Utc::now().to_rfc3339(),
            )?;
            queue_cloud_move(&transaction, Some(&folder.id), &root_ids, Some(project_id))?;
        }
        for id in &missing {
            transaction
                .execute(
                    "DELETE FROM folder_items WHERE folder_id = ?1 AND creation_id = ?2",
                    params![folder.id, id],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "DELETE FROM project_assets WHERE project_id = ?1 AND creation_id = ?2",
                    params![project_id, id],
                )
                .map_err(|e| e.to_string())?;
        }
        let folder = get_folder(&transaction, &folder.id)?
            .ok_or_else(|| "Marked project folder disappeared after cleanup".to_string())?;
        let mut result = finish_reconcile(&transaction, project_id, folder, "marked")?;
        result.missing_creation_ids = missing;
        transaction.commit().map_err(|e| e.to_string())?;
        emit_folders_updated(&app, &list_folders(&conn)?);
        return Ok(result);
    }

    let native_bound: Option<String> = transaction
        .query_row(
            "SELECT folder_id FROM project_library_bindings
             WHERE project_id = ?1 AND binding_known = 1",
            params![project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    let mut bindings: BTreeSet<String> = bound_folder_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if let Some(id) = native_bound {
        bindings.insert(id);
    }
    let mut binding_problem = None;
    if bindings.len() == 1 {
        let id = bindings.iter().next().expect("one binding");
        if let Some(folder) = get_folder(&transaction, id)? {
            if folder.kind == "regular" || folder.project_id.as_deref() == Some(project_id) {
                let folder = claim_regular_folder(&transaction, id, project_id, &title)?;
                let result = finish_reconcile(&transaction, project_id, folder, "bound")?;
                transaction.commit().map_err(|e| e.to_string())?;
                emit_folders_updated(&app, &list_folders(&conn)?);
                return Ok(result);
            }
            binding_problem = Some(format!(
                "The bound folder belongs to project {}",
                folder.project_id.unwrap_or_else(|| "(unknown)".into())
            ));
        } else {
            binding_problem = Some(format!("The bound folder {id} no longer exists"));
        }
    } else if bindings.len() > 1 {
        binding_problem = Some(format!(
            "Project records disagree about the bound folder: {}",
            bindings.into_iter().collect::<Vec<_>>().join(", ")
        ));
    }

    let mut legacy_ids: BTreeSet<String> = legacy_asset_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let mut legacy_stmt = transaction
        .prepare("SELECT creation_id FROM project_assets WHERE project_id = ?1")
        .map_err(|e| e.to_string())?;
    let cached_ids = legacy_stmt
        .query_map(params![project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(legacy_stmt);
    legacy_ids.extend(cached_ids);
    if legacy_ids.is_empty() {
        let folder = create_marked_project_folder(&transaction, project_id, &title)?;
        let result = finish_reconcile(&transaction, project_id, folder, "empty")?;
        transaction.commit().map_err(|e| e.to_string())?;
        emit_folders_updated(&app, &list_folders(&conn)?);
        return Ok(result);
    }

    let mut missing = Vec::new();
    let mut locations: BTreeMap<Option<String>, Vec<String>> = BTreeMap::new();
    for id in legacy_ids {
        match creation_location(&transaction, &paths, &id)? {
            None => missing.push(id),
            Some(location) => locations.entry(location).or_default().push(id),
        }
    }
    // Missing catalog rows are stale project references, not evidence that the
    // surviving assets are split across folders. They must not block legacy
    // project-folder assignment.
    if locations.is_empty() {
        let folder = create_marked_project_folder(&transaction, project_id, &title)?;
        let mut result = finish_reconcile(&transaction, project_id, folder, "empty")?;
        result.missing_creation_ids = missing;
        transaction.commit().map_err(|e| e.to_string())?;
        emit_folders_updated(&app, &list_folders(&conn)?);
        return Ok(result);
    }
    // A common legacy shape is one candidate folder plus a few project assets
    // left at Library root. Consolidate those surviving root assets into the
    // sole candidate instead of making the user repair the layout manually.
    if locations.len() == 2 && locations.contains_key(&None) {
        let candidate_id = locations
            .keys()
            .find_map(|id| id.clone())
            .expect("mixed legacy layout has a candidate folder");
        let root_ids = locations.remove(&None).unwrap_or_default();
        let candidate = get_folder(&transaction, &candidate_id)?
            .ok_or_else(|| "Candidate folder disappeared".to_string())?;
        if candidate.kind == "project" && candidate.project_id.as_deref() != Some(project_id) {
            return blocker_result(&transaction, &locations, Vec::new(), binding_problem);
        }
        let claimed = claim_regular_folder(&transaction, &candidate_id, project_id, &title)?;
        move_creations_into_folder(
            &transaction,
            &claimed.id,
            &root_ids,
            &Utc::now().to_rfc3339(),
        )?;
        queue_cloud_move(&transaction, Some(&claimed.id), &root_ids, Some(project_id))?;
        let folder = get_folder(&transaction, &claimed.id)?
            .ok_or_else(|| "Candidate folder disappeared after filing root assets".to_string())?;
        let mut result = finish_reconcile(&transaction, project_id, folder, "single-folder")?;
        result.missing_creation_ids = missing;
        transaction.commit().map_err(|e| e.to_string())?;
        emit_folders_updated(&app, &list_folders(&conn)?);
        return Ok(result);
    }
    if locations.len() != 1 {
        return blocker_result(&transaction, &locations, Vec::new(), binding_problem);
    }

    let (location, ids) = locations.iter().next().expect("one location");
    let (folder, resolution) = match location {
        None => {
            let folder = create_marked_project_folder(&transaction, project_id, &title)?;
            move_creations_into_folder(&transaction, &folder.id, ids, &Utc::now().to_rfc3339())?;
            queue_cloud_move(&transaction, Some(&folder.id), ids, Some(project_id))?;
            (
                get_folder(&transaction, &folder.id)?.ok_or_else(|| {
                    "Project folder disappeared while filing root assets".to_string()
                })?,
                "all-root",
            )
        }
        Some(folder_id) => {
            let candidate = get_folder(&transaction, folder_id)?
                .ok_or_else(|| "Candidate folder disappeared".to_string())?;
            if candidate.kind == "project" && candidate.project_id.as_deref() != Some(project_id) {
                return blocker_result(&transaction, &locations, Vec::new(), binding_problem);
            }
            (
                claim_regular_folder(&transaction, folder_id, project_id, &title)?,
                "single-folder",
            )
        }
    };
    let mut result = finish_reconcile(&transaction, project_id, folder, resolution)?;
    result.missing_creation_ids = missing;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(result)
}

#[tauri::command]
pub fn library_get_project_folder(project_id: String) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    required_project_folder(&conn, project_id.trim())
}

#[tauri::command]
pub fn library_get_project_bound_folder(project_id: String) -> Result<Option<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    if let Some(folder) = project_folder(&conn, project_id.trim())? {
        return Ok(Some(folder.id));
    }
    conn.query_row(
        "SELECT folder_id FROM project_library_bindings WHERE project_id = ?1 AND binding_known = 1",
        params![project_id.trim()],
        |row| row.get(0),
    )
    .optional()
    .map(|row| row.flatten())
    .map_err(|e| e.to_string())
}

/// Compatibility-only writer retained for one release. New UI does not expose binding.
#[tauri::command]
pub fn library_set_project_bound_folder(
    project_id: String,
    folder_id: Option<String>,
    creation_ids: Vec<String>,
) -> Result<(), String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    if project_folder(&conn, project_id)?.is_some() {
        return Err("Ready projects cannot be rebound".into());
    }
    let folder_id = folder_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    conn.execute(
        "INSERT INTO project_library_bindings(project_id, folder_id, binding_known) VALUES (?1, ?2, 1)
         ON CONFLICT(project_id) DO UPDATE SET folder_id = excluded.folder_id, binding_known = 1",
        params![project_id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    for id in creation_ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO project_assets(project_id, creation_id, added_at) VALUES (?1, ?2, ?3)",
            params![project_id, id, Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_rename_project(
    app: AppHandle,
    project_id: String,
    title: String,
) -> Result<LibraryFolder, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    require_local_project_document(&conn, project_id.trim())?;
    let folder = required_project_folder(&conn, project_id.trim())?;
    let title = normalize_project_title(&title);
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE folders SET title = ?1, updated_at = ?2 WHERE id = ?3",
        params![title, now, folder.id],
    )
    .map_err(|e| e.to_string())?;
    enqueue_op(
        &conn,
        json!({
            "op": "update",
            "id": folder.id,
            "title": title,
            "description": folder.description,
            "meta": cloud_meta_for_folder(&LibraryFolder {
                title: title.clone(),
                ..folder.clone()
            }),
            "project_id": project_id.trim(),
        }),
    )?;
    let updated =
        get_folder(&conn, &folder.id)?.ok_or_else(|| "Project folder not found".to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(updated)
}

#[tauri::command]
pub fn library_import_project_asset_paths(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
) -> Result<ImportLocalResult, String> {
    import_local_paths_for_project(&app, project_id.trim(), paths)
}

/// Job worker entry — import generate outputs into a project Assets folder.
pub(crate) fn import_local_paths_for_project(
    app: &AppHandle,
    project_id: &str,
    paths: Vec<String>,
) -> Result<ImportLocalResult, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let catalog_paths = default_paths()?;
    let conn = ready_connection(&catalog_paths)?;
    require_local_project_document(&conn, project_id)?;
    let folder = required_project_folder(&conn, project_id)?;
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    import_paths(app, &files, Some(&folder.id), Some(project_id))
}

#[tauri::command]
pub fn library_list_project_asset_ids(project_id: String) -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    Ok(required_project_folder(&conn, project_id.trim())?.member_ids)
}

fn usage_blockers(
    conn: &Connection,
    project_id: &str,
    creation_ids: &[String],
) -> Result<Vec<ProjectAssetUsageBlocker>, String> {
    let revision: Option<(String, String)> = conn
        .query_row(
            "SELECT document_revision, state FROM project_usage_revisions WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if revision.as_ref().map(|(_, state)| state.as_str()) != Some("ready") {
        return Err(format!("Project {project_id} usage index is not ready"));
    }
    let mut out = Vec::new();
    for creation_id in creation_ids {
        let mut stmt = conn
            .prepare(
                "SELECT creation_id, usage_kind, usage_owner_id, usage_owner_label
                 FROM project_asset_usage WHERE project_id = ?1 AND creation_id = ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![project_id, creation_id], |row| {
                Ok(ProjectAssetUsageBlocker {
                    project_id: project_id.to_string(),
                    creation_id: row.get(0)?,
                    usage_kind: row.get(1)?,
                    usage_owner_id: row.get(2)?,
                    usage_owner_label: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

/// Member ids of group covers that are currently filed in the project folder.
/// Used so cabinet members can be unfiled without timeline usage blocking.
fn cabinet_member_ids_of_folder_covers(
    conn: &Connection,
    folder_member_ids: &[String],
) -> Result<BTreeSet<String>, String> {
    let mut out = BTreeSet::new();
    for cover_id in folder_member_ids {
        let raw: Option<String> = conn
            .query_row(
                "SELECT remote_json FROM creations WHERE id = ?1",
                params![cover_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(raw) = raw.filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let is_group = value
            .pointer("/meta/group/kind")
            .or_else(|| value.pointer("/group/kind"))
            .and_then(|v| v.as_str())
            == Some("group_creations");
        if !is_group {
            continue;
        }
        for member_id in group_member_ids(&value) {
            if member_id != *cover_id {
                out.insert(member_id);
            }
        }
    }
    Ok(out)
}

fn add_project_assets_transaction(
    transaction: &Transaction<'_>,
    project_id: &str,
    creation_ids: &[String],
    allow_cross_project_move: bool,
) -> Result<ProjectAssetMutationResult, String> {
    require_local_project_document(transaction, project_id)?;
    let folder = required_project_folder(transaction, project_id)?;
    let mut source_projects: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in creation_ids {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM creations WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Creation {id} was not found"));
        }
        let source_project: Option<String> = transaction
            .query_row(
                "SELECT f.project_id FROM folder_items fi JOIN folders f ON f.id = fi.folder_id
                 WHERE fi.creation_id = ?1 AND f.kind = 'project' AND f.project_id != ?2 LIMIT 1",
                params![id, project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(source_project) = source_project {
            if !allow_cross_project_move {
                return Err(format!(
                    "Creation {id} belongs to project {source_project}. Confirm moving it to this project."
                ));
            }
            let blockers = usage_blockers(transaction, &source_project, std::slice::from_ref(id))?;
            if !blockers.is_empty() {
                return Err(format!(
                    "Creation {id} is used by project {source_project} and cannot be moved"
                ));
            }
            source_projects
                .entry(source_project)
                .or_default()
                .push(id.clone());
        }
    }
    let now = Utc::now().to_rfc3339();
    move_creations_into_folder(transaction, &folder.id, creation_ids, &now)?;
    // The server protects each project marker independently. Release a
    // cross-project source with its own assertion before filing into the target.
    for (source_project, source_ids) in &source_projects {
        queue_cloud_move(transaction, None, source_ids, Some(source_project.as_str()))?;
    }
    queue_cloud_move(
        transaction,
        Some(&folder.id),
        creation_ids,
        Some(project_id),
    )?;
    let updated = get_folder(transaction, &folder.id)?
        .ok_or_else(|| "Project folder not found after filing".to_string())?;
    replace_project_asset_cache(transaction, project_id, &updated.member_ids)?;
    for source_project in source_projects.keys() {
        let source_folder = required_project_folder(transaction, source_project)?;
        replace_project_asset_cache(transaction, source_project, &source_folder.member_ids)?;
        mark_membership_mirror_stale(transaction, source_project)?;
        increment_membership_revision(transaction, source_project)?;
    }
    let revision = increment_membership_revision(transaction, project_id)?;
    Ok(ProjectAssetMutationResult {
        folder: updated,
        membership_revision: revision,
        missing_creation_ids: Vec::new(),
    })
}

#[tauri::command]
pub fn library_provision_project_folder(
    app: AppHandle,
    project_id: String,
    title: String,
    creation_ids: Vec<String>,
) -> Result<ProjectAssetMutationResult, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let ids: Vec<String> = creation_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let folder = create_marked_project_folder(&transaction, project_id, &title)?;
    let mut present = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM creations WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            present.push(id);
        } else {
            missing.push(id);
        }
    }
    let mut result = if present.is_empty() {
        replace_project_asset_cache(&transaction, project_id, &folder.member_ids)?;
        ProjectAssetMutationResult {
            folder,
            membership_revision: increment_membership_revision(&transaction, project_id)?,
            missing_creation_ids: Vec::new(),
        }
    } else {
        // "New project from selection" is explicit transfer intent. A source
        // project still blocks the whole transaction when any selected asset
        // is used or its usage snapshot is not ready.
        add_project_assets_transaction(&transaction, project_id, &present, true)?
    };
    result.missing_creation_ids = missing;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("project-assets-updated", &result);
    Ok(result)
}

#[tauri::command]
pub fn library_add_project_assets(
    app: AppHandle,
    project_id: String,
    creation_ids: Vec<String>,
    allow_cross_project_move: bool,
) -> Result<ProjectAssetMutationResult, String> {
    let project_id = project_id.trim();
    let ids: Vec<String> = creation_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let result =
        add_project_assets_transaction(&transaction, project_id, &ids, allow_cross_project_move)?;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("project-assets-updated", &result);
    Ok(result)
}

#[tauri::command]
pub fn library_add_existing_project_asset(
    app: AppHandle,
    project_id: String,
    creation_id: String,
) -> Result<(), String> {
    library_add_project_assets(app, project_id, vec![creation_id], false).map(|_| ())
}

#[tauri::command]
pub fn library_remove_project_assets(
    app: AppHandle,
    project_id: String,
    creation_ids: Vec<String>,
) -> Result<ProjectAssetMutationResult, String> {
    let project_id = project_id.trim();
    let ids: Vec<String> = creation_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let folder = required_project_folder(&transaction, project_id)?;
    let folder_member_set: BTreeSet<&str> =
        folder.member_ids.iter().map(|s| s.as_str()).collect();
    let ids_in_folder: Vec<String> = ids
        .iter()
        .filter(|id| folder_member_set.contains(id.as_str()))
        .cloned()
        .collect();
    if ids_in_folder.is_empty() {
        let revision = transaction
            .query_row(
                "SELECT revision FROM project_membership_revisions WHERE project_id = ?1",
                params![project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        transaction.commit().map_err(|e| e.to_string())?;
        let result = ProjectAssetMutationResult {
            folder,
            membership_revision: revision,
            missing_creation_ids: Vec::new(),
        };
        emit_folders_updated(&app, &list_folders(&conn)?);
        let _ = app.emit("project-assets-updated", &result);
        return Ok(result);
    }
    let cabinet_members =
        cabinet_member_ids_of_folder_covers(&transaction, &folder.member_ids)?;
    let blockers = usage_blockers(&transaction, project_id, &ids_in_folder)?
        .into_iter()
        .filter(|row| !cabinet_members.contains(&row.creation_id))
        .collect::<Vec<_>>();
    if !blockers.is_empty() {
        let labels = blockers
            .iter()
            .map(|row| row.usage_owner_label.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("Selected files are still used by {labels}"));
    }
    remove_from_project_folder(&transaction, project_id, &ids_in_folder)?;
    let updated = get_folder(&transaction, &folder.id)?
        .ok_or_else(|| "Project folder not found after removal".to_string())?;
    replace_project_asset_cache(&transaction, project_id, &updated.member_ids)?;
    mark_membership_mirror_stale(&transaction, project_id)?;
    let revision = increment_membership_revision(&transaction, project_id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    let result = ProjectAssetMutationResult {
        folder: updated,
        membership_revision: revision,
        missing_creation_ids: Vec::new(),
    };
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("project-assets-updated", &result);
    Ok(result)
}

#[tauri::command]
pub fn library_mark_project_usage_stale(
    project_id: String,
    expected_document_revision: Option<String>,
    next_document_revision: String,
    allow_existing_stale: bool,
) -> Result<(), String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let current: Option<(String, String)> = conn
        .query_row(
            "SELECT document_revision, state FROM project_usage_revisions WHERE project_id = ?1",
            params![project_id.trim()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if current.as_ref().map(|(revision, _)| revision.clone()) != expected_document_revision {
        return Err("Project document revision changed; reload and retry".into());
    }
    if current.as_ref().is_some_and(|(_, state)| state == "stale") && !allow_existing_stale {
        return Err(
            "Project membership changed and must be mirrored before editing the project".into(),
        );
    }
    conn.execute(
        "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
         VALUES (?1, ?2, 'stale', NULL)
         ON CONFLICT(project_id) DO UPDATE SET document_revision = excluded.document_revision,
           state = 'stale', indexed_at = NULL",
        params![project_id.trim(), next_document_revision],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn replace_usage(
    conn: &Connection,
    project_id: &str,
    document_revision: &str,
    usage_rows: &[ProjectAssetUsageInput],
) -> Result<(), String> {
    let current: Option<(String, String)> = conn
        .query_row(
            "SELECT document_revision, state FROM project_usage_revisions WHERE project_id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((revision, _)) = current.as_ref() {
        if revision != document_revision {
            return Err("Usage snapshot does not match the project document revision".into());
        }
    }
    conn.execute(
        "DELETE FROM project_asset_usage WHERE project_id = ?1",
        params![project_id],
    )
    .map_err(|e| e.to_string())?;
    for row in usage_rows {
        if row.creation_id.trim().is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR REPLACE INTO project_asset_usage(
               project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label, document_revision
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project_id,
                row.creation_id.trim(),
                row.usage_kind,
                row.usage_owner_id,
                row.usage_owner_label,
                document_revision,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
         VALUES (?1, ?2, 'ready', ?3)
         ON CONFLICT(project_id) DO UPDATE SET document_revision = excluded.document_revision,
           state = 'ready', indexed_at = excluded.indexed_at",
        params![project_id, document_revision, Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn library_replace_project_usage(
    project_id: String,
    document_revision: String,
    usage_rows: Vec<ProjectAssetUsageInput>,
) -> Result<(), String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    replace_usage(
        &transaction,
        project_id.trim(),
        document_revision.trim(),
        &usage_rows,
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_repair_project_usage(
    project_id: String,
    document_revision: String,
    usage_rows: Vec<ProjectAssetUsageInput>,
) -> Result<(), String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute(
            "INSERT INTO project_usage_revisions(project_id, document_revision, state, indexed_at)
             VALUES (?1, ?2, 'stale', NULL)
             ON CONFLICT(project_id) DO UPDATE SET document_revision = excluded.document_revision,
               state = 'stale', indexed_at = NULL",
            params![project_id.trim(), document_revision.trim()],
        )
        .map_err(|e| e.to_string())?;
    replace_usage(
        &transaction,
        project_id.trim(),
        document_revision.trim(),
        &usage_rows,
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_check_creation_usage(
    creation_ids: Vec<String>,
) -> Result<Vec<ProjectAssetUsageBlocker>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let stale: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM project_usage_revisions r
               WHERE r.state != 'ready'
                 AND EXISTS (
                   SELECT 1 FROM folders f
                   WHERE f.kind = 'project' AND f.project_id = r.project_id
                 )
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if stale {
        return Err("Project usage is still being indexed".into());
    }
    let wanted: BTreeSet<String> = creation_ids.into_iter().collect();
    let mut stmt = conn
        .prepare(
            "SELECT project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label
             FROM project_asset_usage ORDER BY project_id, creation_id, usage_kind",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectAssetUsageBlocker {
                project_id: row.get(0)?,
                creation_id: row.get(1)?,
                usage_kind: row.get(2)?,
                usage_owner_id: row.get(3)?,
                usage_owner_label: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let row = row.map_err(|e| e.to_string())?;
        if wanted.contains(&row.creation_id)
            && project_folder(&conn, &row.project_id)?.is_some()
        {
            out.push(row);
        }
    }
    Ok(out)
}

fn project_usage_state(conn: &Connection, project_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT state FROM project_usage_revisions WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Item-scoped Library delete: only this creation's usage and owning project folder matter.
/// Unrelated orphan/stale project folders do not block deletion.
#[tauri::command]
pub fn library_delete_creation_checked(
    app: AppHandle,
    creation_id: String,
    audited_project_ids: Vec<String>,
) -> Result<SyncStatus, String> {
    let id = creation_id.trim();
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    prune_stale_creation_usage(&transaction, id, Some(&audited_project_ids))?;
    let mut stmt = transaction
        .prepare(
            "SELECT project_id, creation_id, usage_kind, usage_owner_id, usage_owner_label
             FROM project_asset_usage WHERE creation_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let blockers: Vec<ProjectAssetUsageBlocker> = stmt
        .query_map(params![id], |row| {
            Ok(ProjectAssetUsageBlocker {
                project_id: row.get(0)?,
                creation_id: row.get(1)?,
                usage_kind: row.get(2)?,
                usage_owner_id: row.get(3)?,
                usage_owner_label: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    if !blockers.is_empty() {
        let details = blockers
            .iter()
            .map(|row| format!("{} ({})", row.usage_owner_label, row.project_id))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("This creation is used by {details}"));
    }
    let owner: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT f.project_id, f.id, f.title FROM folder_items fi
             JOIN folders f ON f.id = fi.folder_id
             WHERE fi.creation_id = ?1 AND f.kind = 'project' LIMIT 1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((project_id, _folder_id, title)) = owner.as_ref() {
        let state = project_usage_state(&transaction, project_id)?;
        if state.as_deref() != Some("ready") {
            return Err(format!(
                "This creation belongs to project folder \"{title}\" which cannot be audited on this device"
            ));
        }
        remove_from_project_folder(&transaction, project_id, &[id.to_string()])?;
        transaction
            .execute(
                "DELETE FROM project_assets WHERE project_id = ?1 AND creation_id = ?2",
                params![project_id, id],
            )
            .map_err(|e| e.to_string())?;
        increment_membership_revision(&transaction, project_id)?;
    } else {
        remove_from_folder(&transaction, &[id.to_string()])?;
    }
    delete_creation_local(&transaction, &paths, id)?;
    if let Some((project_id, _, _)) = owner.as_ref() {
        mark_membership_mirror_stale(&transaction, project_id)?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("library-creation-deleted", id);
    sync_status_for(&paths)
}

/// Deprecated compatibility command. Checked global deletion now belongs to Library.
#[tauri::command]
pub fn library_delete_project_asset(
    app: AppHandle,
    project_id: String,
    creation_id: String,
) -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let folder = required_project_folder(&transaction, project_id.trim())?;
    if !folder.member_ids.iter().any(|id| id == creation_id.trim()) {
        return Err("Creation is not an asset of this project".into());
    }
    let blockers = usage_blockers(&transaction, project_id.trim(), &[creation_id.clone()])?;
    if !blockers.is_empty() {
        return Err("This project asset is still in use".into());
    }
    // Deliberately remove project ownership first; delete_creation_local then applies
    // the all-project usage guard used by the ordinary Library delete command.
    remove_from_project_folder(&transaction, project_id.trim(), &[creation_id.clone()])?;
    delete_creation_local(&transaction, &paths, creation_id.trim())?;
    mark_membership_mirror_stale(&transaction, project_id.trim())?;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("library-creation-deleted", creation_id);
    sync_status_for(&paths)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectResult {
    pub project_id: String,
    pub folder_id: Option<String>,
    /// Former project-folder members (still filed in the released regular folder).
    pub released_member_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiberateOrphanFoldersResult {
    pub released: Vec<LibraryFolder>,
}

/// Convert a project's marked folder to a regular folder (members kept) and clear
/// native usage/membership rows. Catalog media is kept.
#[tauri::command]
pub fn library_delete_project(
    app: AppHandle,
    project_id: String,
) -> Result<DeleteProjectResult, String> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let folder = project_folder(&transaction, &project_id)?;
    let released_member_ids = folder
        .as_ref()
        .map(|f| f.member_ids.clone())
        .unwrap_or_default();
    let folder_id = folder.as_ref().map(|f| f.id.clone());
    if let Some(folder) = folder.as_ref() {
        convert_marked_project_folder_to_regular(&transaction, &project_id, &folder.id)?;
    }
    clear_native_project_index(&transaction, &project_id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let result = DeleteProjectResult {
        project_id: project_id.clone(),
        folder_id,
        released_member_ids,
    };
    let _ = app.emit("project-deleted", &result);
    Ok(result)
}

/// Convert orphan/foreign project folders (no local usage revision) to regular folders.
#[tauri::command]
pub fn library_liberate_orphan_project_folders(
    app: AppHandle,
) -> Result<LiberateOrphanFoldersResult, String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let released = liberate_orphan_project_folders(&transaction)?;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(LiberateOrphanFoldersResult { released })
}

/// Release one orphan project folder (no local usage revision) as a regular folder.
#[tauri::command]
pub fn library_release_orphan_project_folder(
    app: AppHandle,
    folder_id: String,
) -> Result<LibraryFolder, String> {
    let folder_id = folder_id.trim().to_string();
    if folder_id.is_empty() {
        return Err("Folder id is required".into());
    }
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let folder = get_folder(&transaction, &folder_id)?
        .ok_or_else(|| format!("Folder {folder_id} was not found"))?;
    if folder.kind != "project" {
        return Err("Only project folders can be released this way".into());
    }
    let project_id = folder
        .project_id
        .as_deref()
        .ok_or_else(|| "Project folder is missing a project id".to_string())?;
    let known: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_usage_revisions WHERE project_id = ?1)",
            params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if known {
        return Err(
            "This project folder still has a local project document. Delete the project instead."
                .into(),
        );
    }
    let released =
        convert_marked_project_folder_to_regular(&transaction, project_id, &folder_id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(released)
}
