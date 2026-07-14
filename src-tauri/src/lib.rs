mod auth_store;
mod http_client;
mod oauth_listener;

use auth_store::{keychain_delete, keychain_get, keychain_set};
use http_client::{http_get_bearer, http_post_json};
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
            start_oauth_listener,
            cancel_oauth_listener,
            http_post_json,
            http_get_bearer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
