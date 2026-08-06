use super::catalog::{
    default_paths, delete_creation_local, ready_connection, sync_status_for, SyncStatus,
};
use super::folders::{emit_folders_updated, list_folders};
use super::folders::move_creations_into_folder;
use super::import_local::{import_paths, ImportLocalResult};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

fn resolve_project_folder(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Option<String>, String> {
    let stored: Option<(Option<String>, bool)> = conn
        .query_row(
            "SELECT folder_id, binding_known FROM project_library_bindings WHERE project_id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .ok();
    if let Some((folder_id, true)) = stored {
        return Ok(folder_id);
    }
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT fi.folder_id
             FROM project_assets pa
             JOIN folder_items fi ON fi.creation_id = pa.creation_id
             WHERE pa.project_id = ?1 LIMIT 2",
        )
        .map_err(|e| e.to_string())?;
    let folders = stmt
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    if folders.len() != 1 {
        return Ok(None);
    }
    conn.execute(
        "INSERT INTO project_library_bindings(project_id, folder_id, binding_known) VALUES (?1, ?2, 1)
         ON CONFLICT(project_id) DO UPDATE SET folder_id = excluded.folder_id, binding_known = 1",
        rusqlite::params![project_id, folders[0]],
    )
    .map_err(|e| e.to_string())?;
    Ok(folders.into_iter().next())
}

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
    let folder_id = folder_id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    if let Some(folder_id) = folder_id {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM folders WHERE id = ?1)",
                [folder_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("Bound folder was not found".into());
        }
    }
    conn.execute(
        "INSERT INTO project_library_bindings(project_id, folder_id, binding_known) VALUES (?1, ?2, 1)
         ON CONFLICT(project_id) DO UPDATE SET folder_id = excluded.folder_id, binding_known = 1",
        rusqlite::params![project_id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    for creation_id in creation_ids {
        let creation_id = creation_id.trim();
        if creation_id.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO project_assets(project_id, creation_id, added_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![project_id, creation_id, now],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_get_project_bound_folder(project_id: String) -> Result<Option<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    resolve_project_folder(&conn, project_id.trim())
}

/// The project id is the only ownership input. Folder routing is resolved from
/// backend state and committed with the Library row and project membership.
#[tauri::command]
pub fn library_import_project_asset_paths(
    app: AppHandle,
    project_id: String,
    paths: Vec<String>,
) -> Result<ImportLocalResult, String> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err("Project id is required".into());
    }
    let catalog_paths = default_paths()?;
    let conn = ready_connection(&catalog_paths)?;
    let folder_id = resolve_project_folder(&conn, project_id)?;
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    import_paths(
        &app,
        &files,
        folder_id.as_deref(),
        Some(project_id),
    )
}

#[tauri::command]
pub fn library_list_project_asset_ids(project_id: String) -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let mut stmt = conn
        .prepare(
            "SELECT creation_id FROM project_assets WHERE project_id = ?1 ORDER BY added_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project_id.trim()], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_add_existing_project_asset(
    app: AppHandle,
    project_id: String,
    creation_id: String,
) -> Result<(), String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let folder_id = resolve_project_folder(&conn, project_id.trim())?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT OR IGNORE INTO project_assets(project_id, creation_id, added_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![project_id.trim(), creation_id.trim(), now],
        )
        .map_err(|e| e.to_string())?;
    if let Some(folder_id) = folder_id.as_deref() {
        move_creations_into_folder(
            &transaction,
            folder_id,
            &[creation_id.trim().to_string()],
            &now,
        )?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(())
}

#[tauri::command]
pub fn library_delete_project_asset(
    app: AppHandle,
    project_id: String,
    creation_id: String,
) -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let owned: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_assets
             WHERE project_id = ?1 AND creation_id = ?2)",
            rusqlite::params![project_id.trim(), creation_id.trim()],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !owned {
        return Err("Creation is not an asset of this project".into());
    }
    delete_creation_local(&conn, &paths, creation_id.trim())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    let _ = app.emit("library-creation-deleted", creation_id);
    sync_status_for(&paths)
}

#[tauri::command]
pub fn library_remove_project_assets(
    app: AppHandle,
    project_id: String,
    creation_ids: Vec<String>,
) -> Result<(), String> {
    let paths = default_paths()?;
    let mut conn = ready_connection(&paths)?;
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    let ids: Vec<String> = creation_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    super::folders::remove_from_folder(&transaction, &ids)?;
    for id in &ids {
        transaction
            .execute(
                "DELETE FROM project_assets WHERE project_id = ?1 AND creation_id = ?2",
                rusqlite::params![project_id.trim(), id],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    emit_folders_updated(&app, &list_folders(&conn)?);
    Ok(())
}
