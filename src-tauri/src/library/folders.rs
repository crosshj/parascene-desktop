//! Local-only Library folders (not synced to Parascene cloud).

use super::catalog::{default_paths, ready_connection};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

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

fn new_folder_id() -> String {
    format!(
        "folder-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id()
    )
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
        let (id, title, description, created_at, updated_at) =
            row.map_err(|e| e.to_string())?;
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
            .query_map(params![creation_id, folder_id], |row| row.get::<_, String>(0))
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
    let title = title.trim();
    let title = if title.is_empty() {
        "Untitled folder"
    } else {
        title
    };
    let id = new_folder_id();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO folders(id, title, description, created_at, updated_at)
         VALUES (?1, ?2, '', ?3, ?3)",
        params![id, title, now],
    )
    .map_err(|e| e.to_string())?;
    move_creations_into_folder(conn, &id, creation_ids, &now)?;
    get_folder(conn, &id)?.ok_or_else(|| format!("Missing folder {id} after create"))
}

fn rename_folder(
    conn: &Connection,
    id: &str,
    title: &str,
    description: &str,
) -> Result<LibraryFolder, String> {
    let title = title.trim();
    let title = if title.is_empty() {
        "Untitled folder"
    } else {
        title
    };
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::paths::{ensure_directories, resolve_paths};
    use std::env;
    use std::fs;

    fn temp_conn() -> (Connection, std::path::PathBuf) {
        let root = env::temp_dir().join(format!(
            "parascene-folders-test-{}-{}",
            std::process::id(),
            Utc::now().timestamp_millis()
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
        let _ = fs::remove_dir_all(&root);
    }
}
