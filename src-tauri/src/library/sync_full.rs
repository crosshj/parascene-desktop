//! Full catalog sync as a durable job (`sync_full`).
//!
//! Mirrors `src/sync/manifestSync.ts` `syncFullCreationsManifest`:
//! page all creations → map → upsert full manifest.

use super::catalog::{
    apply_manifest, default_paths, existing_creation_ids, map_remote_creation_json,
    ready_connection, sync_status_for, CreationUpsert,
};
use super::parascene_api::list_my_creations;
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::AppHandle;

const PAGE_SIZE: u32 = 100;

fn is_creating_status(status: Option<&str>) -> bool {
    let s = status.unwrap_or("").trim().to_lowercase();
    s == "creating" || s.starts_with("creating")
}

fn is_syncable(row: &CreationUpsert) -> bool {
    !is_creating_status(row.status.as_deref())
}

/// Fetch every syncable creation page and upsert the full manifest.
pub async fn run_sync_full(
    _app: &AppHandle,
    mut note: impl FnMut(&str) -> Result<(), String>,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    note("Checking session…")?;
    cancel()?;

    let mut offset = 0u32;
    let mut pages = 0u32;
    let mut remote_rows: Vec<CreationUpsert> = Vec::new();
    let mut added = 0u32;

    loop {
        cancel()?;
        pages += 1;
        note(&format!("Fetching page {pages}…"))?;
        let (images, has_more) = list_my_creations(PAGE_SIZE, offset).await?;
        if images.is_empty() {
            break;
        }

        for raw in &images {
            match map_remote_creation_json(raw) {
                Ok(row) if is_syncable(&row) => remote_rows.push(row),
                Ok(_) => {}
                Err(_) => continue,
            }
        }

        let checked = remote_rows.len() as u32;
        note(&format!("Checked {checked} creations…"))?;
        offset += images.len() as u32;
        if !has_more {
            break;
        }
    }

    if !remote_rows.is_empty() {
        let ids: Vec<String> = remote_rows.iter().map(|r| r.id.clone()).collect();
        let existing = {
            let paths = default_paths()?;
            let conn = ready_connection(&paths)?;
            existing_creation_ids(&conn, &ids)?
                .into_iter()
                .collect::<HashSet<_>>()
        };
        added = remote_rows
            .iter()
            .filter(|r| !existing.contains(&r.id))
            .count() as u32;

        note(&format!(
            "Saving {} creation(s) ({} new)…",
            remote_rows.len(),
            added
        ))?;
        cancel()?;
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        apply_manifest(&conn, &remote_rows)?;
    } else {
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        apply_manifest(&conn, &[])?;
    }

    let status = sync_status_for(&default_paths()?)?;
    let done_msg = if added > 0 {
        format!("Done · added {added} of {} total", status.total)
    } else {
        format!("Done · catalog refreshed ({})", status.total)
    };
    note(&done_msg)?;

    Ok(json!({
        "added": added,
        "checked": remote_rows.len() as u32,
        "pages": pages,
        "status": status,
        "message": done_msg,
    }))
}
