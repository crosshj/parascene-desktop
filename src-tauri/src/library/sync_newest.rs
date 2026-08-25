//! Newest-window catalog sync as a durable job (`sync_newest`).
//!
//! Mirrors `src/sync/manifestSync.ts` `syncNewestCreationsManifest`:
//! fetch up to 2×50 newest pages → map → upsert → prune recent local ghosts.

use super::catalog::{
    apply_manifest, cloud_ids_since, default_paths, delete_creation_local,
    existing_creation_ids, map_remote_creation_json, ready_connection, sync_status_for,
    CreationUpsert,
};
use super::parascene_api::{get_creation, list_my_creations};
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

const PAGE_SIZE: u32 = 50;
const MAX_PAGES: u32 = 2;
const PRUNE_MAX_AGE_MS: i64 = 6 * 60 * 60 * 1000;

fn is_creating_status(status: Option<&str>) -> bool {
    let s = status.unwrap_or("").trim().to_lowercase();
    s == "creating" || s.starts_with("creating")
}

fn is_syncable(row: &CreationUpsert) -> bool {
    !is_creating_status(row.status.as_deref())
}

fn recent_prune_since_iso(oldest_fetched: &str) -> String {
    let recent_floor = (Utc::now() - Duration::milliseconds(PRUNE_MAX_AGE_MS)).to_rfc3339();
    match chrono::DateTime::parse_from_rfc3339(oldest_fetched) {
        Ok(parsed) => {
            let fetched = parsed.with_timezone(&Utc).to_rfc3339();
            if fetched > recent_floor {
                fetched
            } else {
                recent_floor
            }
        }
        Err(_) => recent_floor,
    }
}

fn delete_local_best_effort(app: &AppHandle, id: &str) -> bool {
    let Ok(paths) = default_paths() else {
        return false;
    };
    let Ok(conn) = ready_connection(&paths) else {
        return false;
    };
    match delete_creation_local(&conn, &paths, id) {
        Ok(()) => {
            let _ = app.emit("library-creation-deleted", id.to_string());
            true
        }
        Err(_) => false,
    }
}

async fn prune_recent_remote_deletions(
    app: &AppHandle,
    remote_rows: &[CreationUpsert],
    mut on_tick: impl FnMut(usize, usize) -> Result<(), String>,
) -> Result<u32, String> {
    if remote_rows.is_empty() {
        on_tick(0, 0)?;
        return Ok(0);
    }
    let remote_ids: HashSet<&str> = remote_rows.iter().map(|r| r.id.as_str()).collect();
    let mut oldest = remote_rows[0].created_at.clone();
    for row in remote_rows {
        if row.created_at < oldest {
            oldest = row.created_at.clone();
        }
    }
    let since = recent_prune_since_iso(&oldest);
    let paths = default_paths()?;
    let locals = {
        let conn = ready_connection(&paths)?;
        cloud_ids_since(&conn, &since)?
    };
    let candidates: Vec<String> = locals
        .into_iter()
        .map(|r| r.id)
        .filter(|id| !remote_ids.contains(id.as_str()))
        .collect();
    if candidates.is_empty() {
        on_tick(0, 0)?;
        return Ok(0);
    }

    let mut pruned = 0u32;
    const PRUNE_CHECK_CAP: usize = 25;
    for (i, id) in candidates.iter().take(PRUNE_CHECK_CAP).enumerate() {
        on_tick(i + 1, candidates.len().min(PRUNE_CHECK_CAP))?;
        match get_creation(id).await {
            Ok(_) => { /* still remote — keep */ }
            Err(err) => {
                let lower = err.to_ascii_lowercase();
                if lower.contains("rate limit")
                    || lower.contains("cooling down")
                    || lower.contains("403")
                    || lower.contains("429")
                {
                    break;
                }
                if delete_local_best_effort(app, id) {
                    pruned += 1;
                }
            }
        }
    }
    Ok(pruned)
}

/// Run newest sync. `note` updates the job progress_note; `cancel` aborts early.
pub async fn run_sync_newest(
    app: &AppHandle,
    mut note: impl FnMut(&str) -> Result<(), String>,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    let target = PAGE_SIZE * MAX_PAGES;
    let mut added = 0u32;
    let mut pruned = 0u32;

    note("Checking session…")?;
    cancel()?;
    // Token refresh happens inside list_my_creations / get_creation.

    note("Fetching newest…")?;
    let mut offset = 0u32;
    let mut pages = 0u32;
    let mut remote_rows: Vec<CreationUpsert> = Vec::new();
    let mut last_status = None;

    loop {
        cancel()?;
        if pages >= MAX_PAGES {
            break;
        }
        let page_num = pages + 1;
        note(&format!("Fetching page {page_num} of {MAX_PAGES}…"))?;
        let (images, has_more) = list_my_creations(PAGE_SIZE, offset).await?;
        pages += 1;
        if images.is_empty() {
            break;
        }

        let mut upserts = Vec::with_capacity(images.len());
        for raw in &images {
            match map_remote_creation_json(raw) {
                Ok(row) => upserts.push(row),
                Err(_) => continue,
            }
        }
        remote_rows.extend(upserts.iter().cloned());
        let checked = remote_rows.len() as u32;
        note(&format!("Checked {checked} of ~{target} newest…"))?;

        let syncable: Vec<CreationUpsert> = upserts.into_iter().filter(is_syncable).collect();
        let ids: Vec<String> = syncable.iter().map(|c| c.id.clone()).collect();
        let existing = {
            let paths = default_paths()?;
            let conn = ready_connection(&paths)?;
            let found = existing_creation_ids(&conn, &ids)?;
            found.into_iter().collect::<HashSet<_>>()
        };
        let new_count = syncable
            .iter()
            .filter(|c| !existing.contains(&c.id))
            .count() as u32;

        if !syncable.is_empty() {
            let apply_msg = if new_count > 0 {
                format!("Saving {new_count} new creation(s) ({checked} of ~{target})…")
            } else {
                format!(
                    "Refreshing {} creation(s) ({checked} of ~{target})…",
                    syncable.len()
                )
            };
            note(&apply_msg)?;
            let paths = default_paths()?;
            let conn = ready_connection(&paths)?;
            apply_manifest(&conn, &syncable)?;
            last_status = Some(sync_status_for(&paths)?);
            added += new_count;
            note(&format!(
                "Added {added} so far · checked {checked} of ~{target}"
            ))?;
        }

        let all_known = !syncable.is_empty() && syncable.iter().all(|c| existing.contains(&c.id));
        if all_known {
            note(&format!("Caught up · checked {checked} of ~{target}"))?;
            break;
        }
        if !has_more {
            break;
        }
        offset += images.len() as u32;
    }

    if !remote_rows.is_empty() {
        note(&format!(
            "Checking recent deletions ({} of ~{target})…",
            remote_rows.len()
        ))?;
        pruned = prune_recent_remote_deletions(app, &remote_rows, |done, total| {
            cancel()?;
            if total == 0 {
                note("No recent deletions to clear")
            } else {
                note(&format!("Removing deleted locally {done} of {total}…"))
            }
        })
        .await?;
    }

    let status = match (&last_status, pruned) {
        (Some(s), 0) => s.clone(),
        _ => {
            let paths = default_paths()?;
            if last_status.is_none() {
                let conn = ready_connection(&paths)?;
                apply_manifest(&conn, &[])?;
            }
            sync_status_for(&paths)?
        }
    };

    let done_msg = if added > 0 || pruned > 0 {
        format!("Done · added {added}, removed {pruned}")
    } else {
        format!("Done · nothing new in newest ~{target}")
    };
    note(&done_msg)?;

    Ok(json!({
        "added": added,
        "pruned": pruned,
        "checked": remote_rows.len() as u32,
        "target": target,
        "status": status,
        "message": done_msg,
    }))
}
