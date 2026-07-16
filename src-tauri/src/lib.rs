mod auth_store;
mod http_client;
mod library;
mod oauth_listener;

use auth_store::{
    auth_ensure_access_token, keychain_delete, keychain_get, keychain_set,
};
use http_client::{http_get_bearer, http_post_bearer, http_post_json};
use library::{
    library_apply_manifest, library_cache_missing_media, library_cache_missing_thumbs,
    library_delete_local, library_download_ids, library_download_pending, library_download_thumbs,
    library_ensure_local, library_ensure_ready, library_ensure_reversed, library_fill_thumb,
    library_filter_counts, library_get_creation, library_import_from_disk,
    library_import_local_paths, library_invalidate_mismatched_thumbs, library_invalidate_thumbs,
    library_list_creations, library_list_creations_page, library_local_fit_plan,
    library_read_local_thumb_base64, library_sync_status,
};
use oauth_listener::{cancel_oauth_listener, start_oauth_listener};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Deep link (parascene://…) just focuses the window after browser return.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                let _ = app.deep_link().on_open_url(move |_event| {
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.set_focus();
                        let _ = window.unminimize();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_get,
            keychain_set,
            keychain_delete,
            auth_ensure_access_token,
            start_oauth_listener,
            cancel_oauth_listener,
            http_post_json,
            http_post_bearer,
            http_get_bearer,
            library_ensure_ready,
            library_get_creation,
            library_list_creations,
            library_list_creations_page,
            library_filter_counts,
            library_sync_status,
            library_apply_manifest,
            library_download_pending,
            library_download_ids,
            library_download_thumbs,
            library_cache_missing_thumbs,
            library_cache_missing_media,
            library_ensure_local,
            library_delete_local,
            library_import_from_disk,
            library_import_local_paths,
            library_invalidate_thumbs,
            library_invalidate_mismatched_thumbs,
            library_local_fit_plan,
            library_fill_thumb,
            library_read_local_thumb_base64,
            library_ensure_reversed
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
