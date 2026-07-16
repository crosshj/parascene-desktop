mod catalog;
mod download;
mod ffmpeg;
mod import_local;
mod paths;
mod proxy;
mod reverse;
mod thumb_fill;

pub use catalog::{
    library_apply_manifest, library_ensure_ready, library_filter_counts, library_get_creation,
    library_invalidate_thumbs, library_list_creations, library_sync_status,
};
pub use download::{
    library_cache_missing_media, library_cache_missing_thumbs, library_delete_local,
    library_download_ids, library_download_pending, library_download_thumbs, library_ensure_local,
    library_invalidate_mismatched_thumbs, library_local_fit_plan,
};
pub use import_local::{library_import_from_disk, library_import_local_paths};
pub use proxy::library_ensure_proxy;
pub use reverse::library_ensure_reversed;
pub use thumb_fill::{library_fill_thumb, library_read_local_thumb_base64};

use catalog::{query_creations_page, CreationPage};
use download::spawn_scroll_ahead;
use tauri::AppHandle;

/// List a page from local SQLite, then warm thumbs several pages ahead of `offset`
/// (high priority). Full media for the listed page is low priority only.
#[tauri::command]
pub async fn library_list_creations_page(
    app: AppHandle,
    limit: u32,
    offset: u32,
) -> Result<CreationPage, String> {
    let page = query_creations_page(limit, offset)?;
    spawn_scroll_ahead(app, limit, offset);
    Ok(page)
}

#[cfg(debug_assertions)]
pub(crate) use catalog::{auth_kv_delete, auth_kv_get, auth_kv_set};
