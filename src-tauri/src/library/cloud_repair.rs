//! Cloud library repair as a durable job (`cloud_repair`).
//!
//! Mirrors `src/sync/cloudRepair.ts` — group aspect → local fit → upload →
//! cloud fit batches → light resync → redownload thumbs.

use super::catalog::{
    apply_manifest, clear_local_thumb_paths, default_paths, map_remote_creation_json,
    ready_connection, sync_status_for,
};
use super::download::{build_local_fit_plan, library_download_thumbs, LocalFitTarget};
use super::parascene_api::{
    get_creation, repair_fit_thumbnails, repair_group_aspect, upload_fit_thumbnail,
};
use super::thumb_fill::{fill_and_record_local_thumb, library_read_local_thumb_base64};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

const BATCH_PACING_MS: u64 = 400;
const UPLOAD_PACING_MS: u64 = 350;
const FIT_BATCH_LIMIT: usize = 25;

async fn sleep_ms(ms: u64) {
    sleep(Duration::from_millis(ms)).await;
}

fn emit_item(app: &AppHandle, id: &str, title: &str, state: &str, detail: &str) {
    let _ = app.emit(
        "library-repair-item",
        json!({
            "id": id,
            "kind": "repair",
            "title": title,
            "state": state,
            "detail": detail,
        }),
    );
}

fn batch_counts(value: &Value) -> (u32, u32, Vec<String>, HashMap<String, String>) {
    let updated_count = value
        .get("updated_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let skipped_count = value
        .get("skipped_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let mut updated_ids = Vec::new();
    if let Some(arr) = value.get("updated").and_then(|v| v.as_array()) {
        for row in arr {
            if let Some(id) = row.get("id").and_then(|v| match v {
                Value::String(s) => Some(s.trim().to_string()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            }) {
                if !id.is_empty() {
                    updated_ids.push(id);
                }
            }
        }
    }
    let mut skipped = HashMap::new();
    if let Some(arr) = value.get("skipped").and_then(|v| v.as_array()) {
        for row in arr {
            let id = row.get("id").and_then(|v| match v {
                Value::String(s) => Some(s.trim().to_string()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
            let Some(id) = id.filter(|s| !s.is_empty()) else {
                continue;
            };
            let reason = row
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("Skipped")
                .to_string();
            skipped.insert(id, reason);
        }
    }
    (updated_count, skipped_count, updated_ids, skipped)
}

async fn push_local_fit(id: &str) -> Result<(), String> {
    let b64 = library_read_local_thumb_base64(id.to_string())?;
    let _ = upload_fit_thumbnail(id, &b64).await?;
    Ok(())
}

async fn fill_and_push(app: &AppHandle, id: &str) -> Result<(), String> {
    let paths = default_paths()?;
    {
        let conn = ready_connection(&paths)?;
        let creation = super::catalog::get_creation_by_id(&conn, id)?
            .ok_or_else(|| format!("Creation {id} not found"))?;
        fill_and_record_local_thumb(&paths, &conn, &creation)?;
        let updated = super::catalog::get_creation_by_id(&conn, id)?
            .ok_or_else(|| format!("Creation {id} missing after fill"))?;
        let _ = app.emit("library-creation-updated", &updated);
    }
    push_local_fit(id).await
}

async fn work_local_target(
    app: &AppHandle,
    target: &LocalFitTarget,
    regenerate: bool,
) -> Result<(), String> {
    let detail_active = if regenerate {
        "Rebuilding local fit + upload"
    } else {
        "Uploading existing local fit"
    };
    let detail_done = if regenerate {
        "Local fit uploaded"
    } else {
        "Existing fit uploaded"
    };
    emit_item(app, &target.id, &target.title, "active", detail_active);
    let result = if regenerate {
        fill_and_push(app, &target.id).await
    } else {
        push_local_fit(&target.id).await
    };
    match result {
        Ok(()) => {
            emit_item(app, &target.id, &target.title, "done", detail_done);
            Ok(())
        }
        Err(err) => {
            emit_item(app, &target.id, &target.title, "failed", &err);
            Err(err)
        }
    }
}

/// Run cloud repair. `note` updates progress_note; `cancel` aborts between items.
pub async fn run_cloud_repair(
    app: &AppHandle,
    mut note: impl FnMut(&str) -> Result<(), String>,
    mut cancel: impl FnMut() -> Result<(), String>,
) -> Result<Value, String> {
    note("Updating group aspects…")?;
    cancel()?;
    let group = repair_group_aspect(100).await?;
    let (group_updated, _, _, _) = batch_counts(&group);
    if group_updated > 0 {
        emit_item(
            app,
            "group-aspect",
            &format!("Group aspects ({group_updated})"),
            "done",
            &format!("Updated {group_updated} group aspect ratios"),
        );
    }

    note("Scanning local thumbs…")?;
    cancel()?;
    let plan = {
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        build_local_fit_plan(&conn)?
    };

    let mut local_filled = 0u32;
    let mut uploaded_only = 0u32;
    let mut touched: HashSet<String> = HashSet::new();
    let mut fit_updated_count = 0u32;
    let mut fit_skipped_count = 0u32;
    let mut server_updated: Vec<String> = Vec::new();

    note("Rebuilding mismatched thumbs…")?;
    for target in &plan.regenerate {
        cancel()?;
        match work_local_target(app, target, true).await {
            Ok(()) => {
                local_filled += 1;
                touched.insert(target.id.clone());
            }
            Err(_) => { /* item already emitted failed */ }
        }
        sleep_ms(UPLOAD_PACING_MS).await;
    }

    note("Uploading local fits…")?;
    for target in &plan.upload_only {
        cancel()?;
        match work_local_target(app, target, false).await {
            Ok(()) => {
                uploaded_only += 1;
                touched.insert(target.id.clone());
            }
            Err(_) => {}
        }
        sleep_ms(UPLOAD_PACING_MS).await;
    }

    note("Cloud fit for items without media…")?;
    let cloud_targets: Vec<&LocalFitTarget> = plan
        .cloud_repair
        .iter()
        .filter(|t| !touched.contains(&t.id))
        .collect();
    for chunk in cloud_targets.chunks(FIT_BATCH_LIMIT) {
        cancel()?;
        for target in chunk {
            emit_item(app, &target.id, &target.title, "active", "Cloud fit repair");
        }
        let ids: Vec<String> = chunk.iter().map(|t| t.id.clone()).collect();
        match repair_fit_thumbnails(&ids, true).await {
            Ok(batch) => {
                let (upd, skip, updated_ids, skipped) = batch_counts(&batch);
                fit_updated_count += upd;
                fit_skipped_count += skip;
                let updated_set: HashSet<_> = updated_ids.iter().cloned().collect();
                for id in updated_ids {
                    touched.insert(id.clone());
                    server_updated.push(id);
                }
                for target in chunk {
                    if updated_set.contains(&target.id) {
                        emit_item(
                            app,
                            &target.id,
                            &target.title,
                            "done",
                            "Cloud fit generated",
                        );
                    } else if let Some(reason) = skipped.get(&target.id) {
                        emit_item(app, &target.id, &target.title, "skipped", reason);
                    } else {
                        emit_item(app, &target.id, &target.title, "skipped", "No change");
                    }
                }
            }
            Err(err) => {
                for target in chunk {
                    emit_item(app, &target.id, &target.title, "failed", &err);
                }
            }
        }
        sleep_ms(BATCH_PACING_MS).await;
    }

    note("Refreshing catalog…")?;
    cancel()?;
    // Light resync: pull detail rows for touched / server-updated ids.
    let mut upserts = Vec::new();
    for id in touched.iter().chain(server_updated.iter()) {
        cancel()?;
        if let Ok(raw) = get_creation(id).await {
            if let Ok(row) = map_remote_creation_json(&raw) {
                upserts.push(row);
            }
        }
    }
    if !upserts.is_empty() {
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        apply_manifest(&conn, &upserts)?;
    }

    note("Refreshing previews…")?;
    cancel()?;
    let mut thumbs_redownloaded = 0u32;
    if !server_updated.is_empty() {
        let paths = default_paths()?;
        {
            let conn = ready_connection(&paths)?;
            let _ = clear_local_thumb_paths(&conn, &server_updated);
        }
        let summary = library_download_thumbs(app.clone(), server_updated.clone()).await?;
        thumbs_redownloaded = summary.downloaded;
    }

    let status = {
        let paths = default_paths()?;
        sync_status_for(&paths)?
    };

    note("Cloud repair done")?;
    Ok(json!({
        "groupUpdated": group_updated,
        "fitUpdated": fit_updated_count,
        "fitSkipped": fit_skipped_count,
        "localFilled": local_filled,
        "uploadedOnly": uploaded_only,
        "thumbsRedownloaded": thumbs_redownloaded,
        "status": status,
    }))
}
