//! Import media files from the filesystem into the local catalog (local-only rows).

use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, sync_status_for, Creation, SyncStatus,
};
use super::proxy::spawn_ensure_proxies;
use super::thumb_fill::fill_and_record_local_thumb;
use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use std::fs;
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
          NULL, NULL, NULL, ?5,
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
        ],
    )
    .map_err(|e| format!("Insert local creation failed: {e}"))?;
    Ok(())
}

fn import_paths(app: &AppHandle, sources: &[PathBuf]) -> Result<ImportLocalResult, String> {
    let paths = default_paths()?;
    let mut imported = Vec::new();

    for (index, source) in sources.iter().enumerate() {
        let Some(media_type) = media_type_for_path(source) else {
            continue;
        };
        if !source.is_file() {
            continue;
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
            let conn = ready_connection(&paths)?;
            insert_local_creation(
                &conn,
                &id,
                stem,
                media_type,
                &filename,
                &dest.display().to_string(),
                width,
                height,
                aspect_ratio.as_deref(),
            )?;
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
        if media_type == "video" || media_type == "image" || media_type == "audio" {
            spawn_ensure_proxies(app.clone(), id.clone());
        }
        imported.push(updated);
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

    import_paths(&app, &files)
}

fn pick_media_files() -> Result<Option<Vec<PathBuf>>, String> {
    #[cfg(target_os = "macos")]
    {
        pick_media_files_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Add from disk is currently only supported on macOS".into())
    }
}

#[cfg(target_os = "macos")]
fn pick_media_files_macos() -> Result<Option<Vec<PathBuf>>, String> {
    // Native picker via osascript (avoids dialog crates that need newer Cargo).
    // Extension filtering happens in `media_type_for_path` after selection.
    let script = r#"
try
  set theFiles to choose file with prompt "Add files to Library" with multiple selections allowed
  set out to ""
  repeat with aFile in theFiles
    set out to out & (POSIX path of aFile) & linefeed
  end repeat
  return out
on error number -128
  return ""
end try
"#;
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("Could not open file picker: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("File picker failed: {err}"));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<PathBuf> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect();
    if paths.is_empty() {
        Ok(None)
    } else {
        Ok(Some(paths))
    }
}

/// Import explicit filesystem paths (useful for tests / automation).
#[tauri::command]
pub fn library_import_local_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<ImportLocalResult, String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    import_paths(&app, &files)
}
