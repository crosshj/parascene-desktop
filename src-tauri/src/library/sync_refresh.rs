//! Page the catalog until wanted ids are found, then upsert those rows.
//!
//! Mirrors `src/sync/manifestSync.ts` `refreshCreationsFromListById`.

use super::catalog::{
    apply_manifest, default_paths, ids_needing_group_list_refresh, map_remote_creation_json,
    ready_connection, CreationUpsert,
};
use super::parascene_api::{creation_id, list_my_creations};
use serde_json::{json, Value};
use std::collections::HashSet;

fn is_creating_status(status: Option<&str>) -> bool {
    let s = status.unwrap_or("").trim().to_lowercase();
    s == "creating" || s.starts_with("creating")
}

fn is_syncable(row: &CreationUpsert) -> bool {
    !is_creating_status(row.status.as_deref())
}

pub async fn run_refresh_creations_by_id(
    ids: &[String],
    max_pages: u32,
    page_size: u32,
) -> Result<Value, String> {
    let wanted: HashSet<String> = ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if wanted.is_empty() {
        return Ok(json!({ "refreshed": 0 }));
    }

    // Skip ids that already have group membership locally — the common case
    // when switching to Editor. Avoid paging the entire remote catalog.
    let wanted = {
        let paths = default_paths()?;
        let conn = ready_connection(&paths)?;
        let remaining =
            ids_needing_group_list_refresh(&conn, &wanted.into_iter().collect::<Vec<_>>())?;
        remaining.into_iter().collect::<HashSet<_>>()
    };
    if wanted.is_empty() {
        return Ok(json!({ "refreshed": 0 }));
    }

    let page_size = page_size.clamp(1, 200);
    let max_pages = max_pages.clamp(1, 200);
    let mut found: HashSet<String> = HashSet::new();
    let mut refreshed = 0u32;
    let mut offset = 0u32;

    for _page in 0..max_pages {
        if found.len() >= wanted.len() {
            break;
        }
        let (images, has_more) = list_my_creations(page_size, offset).await?;
        if images.is_empty() {
            break;
        }

        let mut syncable = Vec::new();
        for raw in &images {
            let Some(id) = creation_id(raw) else {
                continue;
            };
            if !wanted.contains(&id) {
                continue;
            }
            match map_remote_creation_json(raw) {
                Ok(row) if is_syncable(&row) => {
                    found.insert(id);
                    syncable.push(row);
                }
                Ok(_) => {}
                Err(_) => continue,
            }
        }

        if !syncable.is_empty() {
            let paths = default_paths()?;
            let conn = ready_connection(&paths)?;
            apply_manifest(&conn, &syncable)?;
            refreshed += syncable.len() as u32;
        }

        if !has_more {
            break;
        }
        offset += images.len() as u32;
    }

    Ok(json!({ "refreshed": refreshed }))
}
