//! Import media files from the filesystem into the local catalog (local-only rows).

use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, sync_status_for, Creation, SyncStatus,
};
use super::folders::{emit_folders_updated, list_folders, move_creations_into_folder};
use super::thumb_fill::fill_and_record_local_thumb;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalResult {
    pub imported: u32,
    pub cancelled: bool,
    pub creations: Vec<Creation>,
    pub status: SyncStatus,
}

fn media_type_for_path(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())?;
    match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" | "tif" | "tiff" | "heic" | "avif" => {
            Some("image")
        }
        "mp4" | "mov" | "webm" | "m4v" | "mkv" | "avi" => Some("video"),
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "aiff" | "aif" => Some("audio"),
        _ => None,
    }
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.to_string()
    }
}

fn new_local_id(index: usize) -> String {
    format!(
        "local-{}-{}-{}",
        Utc::now().timestamp_millis(),
        std::process::id(),
        index
    )
}

/// SHA-256 of file bytes — used to reuse exact project-asset duplicates.
fn file_content_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("Could not hash {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn find_project_asset_id_by_checksum(
    conn: &rusqlite::Connection,
    project_id: &str,
    checksum: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT c.id FROM creations c
         INNER JOIN project_assets pa ON pa.creation_id = c.id
         WHERE pa.project_id = ?1 AND c.checksum = ?2
         ORDER BY c.created_at ASC
         LIMIT 1",
        params![project_id, checksum],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("Lookup project asset by checksum failed: {e}"))
}

fn set_creation_checksum(
    conn: &rusqlite::Connection,
    id: &str,
    checksum: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE creations SET checksum = ?1, updated_at = ?2 WHERE id = ?3",
        params![checksum, Utc::now().to_rfc3339(), id],
    )
    .map_err(|e| format!("Could not store checksum for {id}: {e}"))?;
    Ok(())
}

/// Prefer an existing project member with the same bytes; backfill checksums when missing.
fn find_or_backfill_project_duplicate(
    conn: &rusqlite::Connection,
    project_id: &str,
    checksum: &str,
    source_len: u64,
) -> Result<Option<String>, String> {
    if let Some(id) = find_project_asset_id_by_checksum(conn, project_id, checksum)? {
        return Ok(Some(id));
    }

    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.checksum, c.local_path FROM creations c
             INNER JOIN project_assets pa ON pa.creation_id = c.id
             WHERE pa.project_id = ?1
               AND c.local_path IS NOT NULL
               AND c.local_path != ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (id, existing_checksum, local_path) = row.map_err(|e| e.to_string())?;
        if let Some(existing) = existing_checksum
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if existing == checksum {
                return Ok(Some(id));
            }
            continue;
        }
        let path = PathBuf::from(&local_path);
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        if meta.len() != source_len || !path.is_file() {
            continue;
        }
        let digest = file_content_sha256(&path)?;
        set_creation_checksum(conn, &id, &digest)?;
        if digest == checksum {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn probe_image_size(path: &Path) -> (Option<i64>, Option<i64>, Option<String>) {
    let Ok(reader) = image::ImageReader::open(path) else {
        return (None, None, None);
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return (None, None, None);
    };
    let Ok((w, h)) = reader.into_dimensions() else {
        return (None, None, None);
    };
    let width = w as i64;
    let height = h as i64;
    let aspect = if width > 0 && height > 0 {
        // Reduce loosely to common presets when close.
        let r = width as f64 / height as f64;
        if (r - 1.0).abs() < 0.05 {
            Some("1:1".into())
        } else if (r - 9.0 / 16.0).abs() < 0.08 {
            Some("9:16".into())
        } else if (r - 4.0 / 5.0).abs() < 0.08 {
            Some("4:5".into())
        } else if (r - 16.0 / 9.0).abs() < 0.08 {
            Some("16:9".into())
        } else {
            Some(format!("{width}:{height}"))
        }
    } else {
        None
    };
    (Some(width), Some(height), aspect)
}

pub(crate) fn insert_local_creation(
    conn: &rusqlite::Connection,
    id: &str,
    title: &str,
    media_type: &str,
    filename: &str,
    local_path: &str,
    width: Option<i64>,
    height: Option<i64>,
    aspect_ratio: Option<&str>,
    checksum: Option<&str>,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        r#"
        INSERT INTO creations (
          id, title, media_type, remote_url, thumbnail_url, fit_thumbnail_url, video_url,
          local_path, local_thumb_path, published, published_at, created_at, download_state,
          checksum, prompt, expires_at, updated_at,
          filename, description, color, status, width, height, aspect_ratio,
          nsfw, is_moderated_error, remote_json
        ) VALUES (
          ?1, ?2, ?3, NULL, NULL, NULL, NULL,
          ?4, NULL, 0, NULL, ?5, 'local',
          ?10, NULL, NULL, ?5,
          ?6, NULL, NULL, 'local', ?7, ?8, ?9,
          0, 0, NULL
        )
        "#,
        params![
            id,
            title,
            media_type,
            local_path,
            now,
            filename,
            width,
            height,
            aspect_ratio,
            checksum,
        ],
    )
    .map_err(|e| format!("Insert local creation failed: {e}"))?;
    Ok(())
}

pub(crate) fn import_paths(
    app: &AppHandle,
    sources: &[PathBuf],
    folder_id: Option<&str>,
    project_id: Option<&str>,
) -> Result<ImportLocalResult, String> {
    let paths = default_paths()?;
    let mut imported = Vec::new();

    if let Some(folder_id) = folder_id {
        let conn = ready_connection(&paths)?;
        let folder: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT kind, project_id FROM folders WHERE id = ?1",
                params![folder_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((kind, owner_project_id)) = folder else {
            return Err(format!("Project working folder {folder_id} was not found"));
        };
        match project_id {
            Some(project_id) => {
                if kind != "project" || owner_project_id.as_deref() != Some(project_id) {
                    return Err("Resolved folder does not belong to this project".into());
                }
                let known: bool = conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM project_usage_revisions WHERE project_id = ?1)",
                        params![project_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !known {
                    return Err(format!(
                        "Project {project_id} is unavailable on this device and cannot receive files"
                    ));
                }
            }
            None if kind == "project" => {
                return Err("Use Add to project to import into a project folder".into());
            }
            None => {}
        }
    }

    for (index, source) in sources.iter().enumerate() {
        let Some(media_type) = media_type_for_path(source) else {
            continue;
        };
        if !source.is_file() {
            continue;
        }

        let checksum = file_content_sha256(source)?;
        let source_len = fs::metadata(source)
            .map(|m| m.len())
            .map_err(|e| format!("Could not stat {}: {e}", source.display()))?;

        // Project Assets: reuse an exact byte-identical member instead of
        // minting another local-* row (guards import loops / re-downloads).
        if let Some(project_id) = project_id {
            let conn = ready_connection(&paths)?;
            if let Some(existing_id) =
                find_or_backfill_project_duplicate(&conn, project_id, &checksum, source_len)?
            {
                if let Some(existing) = get_creation_by_id(&conn, &existing_id)? {
                    let local_ok = existing
                        .local_path
                        .as_deref()
                        .map(|p| Path::new(p).is_file())
                        .unwrap_or(false);
                    if local_ok {
                        if let Some(folder_id) = folder_id {
                            let mut write = ready_connection(&paths)?;
                            let transaction = write.transaction().map_err(|e| e.to_string())?;
                            move_creations_into_folder(
                                &transaction,
                                folder_id,
                                std::slice::from_ref(&existing_id),
                                &Utc::now().to_rfc3339(),
                            )?;
                            transaction.commit().map_err(|e| e.to_string())?;
                        }
                        imported.push(existing);
                        continue;
                    }
                }
            }
        }

        let original_name = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file");
        let filename = sanitize_filename(original_name);
        let stem = Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled");
        let id = new_local_id(index);
        let dest_name = format!("{id}_{filename}");
        let dest = paths.media.join(&dest_name);

        fs::copy(source, &dest).map_err(|e| format!("Could not copy {}: {e}", source.display()))?;

        let (width, height, aspect_ratio) = if media_type == "image" {
            probe_image_size(&dest)
        } else {
            (None, None, None)
        };

        {
            let mut conn = ready_connection(&paths)?;
            let transaction = conn.transaction().map_err(|e| e.to_string())?;
            insert_local_creation(
                &transaction,
                &id,
                stem,
                media_type,
                &filename,
                &dest.display().to_string(),
                width,
                height,
                aspect_ratio.as_deref(),
                Some(&checksum),
            )?;
            if let Some(folder_id) = folder_id {
                move_creations_into_folder(
                    &transaction,
                    folder_id,
                    std::slice::from_ref(&id),
                    &Utc::now().to_rfc3339(),
                )?;
            }
            if let Some(project_id) = project_id {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO project_assets(project_id, creation_id, added_at)
                         VALUES (?1, ?2, ?3)",
                        params![project_id, id, Utc::now().to_rfc3339()],
                    )
                    .map_err(|e| format!("Could not add project asset: {e}"))?;
                transaction
                    .execute(
                        "INSERT INTO project_membership_revisions(project_id, revision) VALUES (?1, 1)
                         ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1",
                        params![project_id],
                    )
                    .map_err(|e| format!("Could not advance project membership: {e}"))?;
            }
            transaction.commit().map_err(|e| e.to_string())?;
        }

        // Best-effort native thumb: image decode, video first frame, or audio cover art.
        let creation = {
            let conn = ready_connection(&paths)?;
            get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after insert"))?
        };
        {
            let conn = ready_connection(&paths)?;
            let _ = fill_and_record_local_thumb(&paths, &conn, &creation);
        }

        let conn = ready_connection(&paths)?;
        let updated =
            get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Missing {id} after thumb"))?;
        let _ = app.emit("library-creation-updated", &updated);
        imported.push(updated);
    }

    if folder_id.is_some() && !imported.is_empty() {
        let conn = ready_connection(&paths)?;
        emit_folders_updated(app, &list_folders(&conn)?);
    }

    let status = sync_status_for(&paths)?;
    Ok(ImportLocalResult {
        imported: imported.len() as u32,
        cancelled: false,
        creations: imported,
        status,
    })
}

/// Open a native multi-file picker and import selected media into the local catalog.
#[tauri::command]
pub async fn library_import_from_disk(app: AppHandle) -> Result<ImportLocalResult, String> {
    let picked = tauri::async_runtime::spawn_blocking(pick_media_files)
        .await
        .map_err(|e| format!("File dialog failed: {e}"))??;

    let Some(files) = picked else {
        let paths = default_paths()?;
        return Ok(ImportLocalResult {
            imported: 0,
            cancelled: true,
            creations: vec![],
            status: sync_status_for(&paths)?,
        });
    };

    import_paths(&app, &files, None, None)
}

fn pick_media_files() -> Result<Option<Vec<PathBuf>>, String> {
    // Extension filtering happens in `media_type_for_path` after selection.
    Ok(rfd::FileDialog::new()
        .set_title("Add files to Library")
        .pick_files())
}

/// Import explicit filesystem paths (useful for tests / automation).
#[tauri::command]
pub fn library_import_local_paths(
    app: AppHandle,
    paths: Vec<String>,
    folder_id: Option<String>,
) -> Result<ImportLocalResult, String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let folder_id = folder_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    import_paths(&app, &files, folder_id, None)
}

#[cfg(test)]
mod tests {
    use super::super::paths::{ensure_directories, resolve_paths};
    use super::*;
    use uuid::Uuid;

    #[test]
    fn bound_import_commits_creation_with_folder_membership() {
        let root = std::env::temp_dir().join(format!(
            "parascene-bound-import-test-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let paths = resolve_paths(root.clone());
        ensure_directories(&paths).expect("directories");
        let mut conn = ready_connection(&paths).expect("connection");
        conn.execute(
            "INSERT INTO folders(id, title, description, created_at, updated_at)
             VALUES ('project-folder', 'Project', '', 't', 't')",
            [],
        )
        .expect("folder");

        let transaction = conn.transaction().expect("transaction");
        insert_local_creation(
            &transaction,
            "local-output",
            "Output",
            "image",
            "output.png",
            "/tmp/output.png",
            Some(100),
            Some(100),
            Some("1:1"),
            None,
        )
        .expect("creation");
        move_creations_into_folder(
            &transaction,
            "project-folder",
            &[String::from("local-output")],
            "t",
        )
        .expect("membership");
        transaction.commit().expect("commit");

        let folder_id: String = conn
            .query_row(
                "SELECT folder_id FROM folder_items WHERE creation_id = 'local-output'",
                [],
                |row| row.get(0),
            )
            .expect("filed creation");
        let root_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM creations c
                 LEFT JOIN folder_items fi ON fi.creation_id = c.id
                 WHERE c.id = 'local-output' AND fi.creation_id IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("root count");
        assert_eq!(folder_id, "project-folder");
        assert_eq!(root_count, 0);

        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn file_content_sha256_is_stable_for_same_bytes() {
        let dir = std::env::temp_dir().join(format!(
            "parascene-hash-test-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("output.mp4");
        fs::write(&path, b"exact-bytes").expect("write");
        let a = file_content_sha256(&path).expect("hash a");
        let b = file_content_sha256(&path).expect("hash b");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        let _ = fs::remove_dir_all(dir);
    }
}
