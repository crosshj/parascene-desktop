//! Durable on-disk diagnostics under `Library/logs/`.

use super::catalog::default_paths;
use serde_json::Value as JsonValue;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;

/// Append one JSON line to `Library/logs/{channel}.jsonl`.
/// Channels are filename-safe tokens (e.g. `folder-sync`).
#[tauri::command]
pub async fn library_append_diag_log(
    channel: String,
    payload: JsonValue,
) -> Result<String, String> {
    let channel = channel.trim();
    if channel.is_empty()
        || channel.len() > 64
        || !channel
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("diag log channel must be a short ascii token".into());
    }
    let paths = default_paths()?;
    create_dir_all(&paths.logs).map_err(|e| format!("Could not create logs dir: {e}"))?;
    let file_path = paths.logs.join(format!("{channel}.jsonl"));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Could not open {}: {e}", file_path.display()))?;
    let line = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| format!("Could not write {}: {e}", file_path.display()))?;
    Ok(file_path.display().to_string())
}
