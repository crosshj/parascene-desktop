mod auth_store;
mod http_client;
mod library;
mod media_stream;
mod oauth_listener;

use auth_store::{auth_ensure_access_token, keychain_delete, keychain_get, keychain_set};
use http_client::{
    http_delete_bearer, http_get_bearer, http_post_bearer, http_post_bytes_bearer, http_post_json,
};
use library::{
    library_add_to_folder, library_apply_manifest, library_cache_missing_media,
    library_cache_missing_thumbs, library_cloud_ids_since, library_create_folder,
    library_delete_folder,
    library_delete_local, library_detect_beats, library_download_ids, library_download_pending,
    library_download_thumbs, library_ensure_clip_thumb, library_ensure_local, library_ensure_ready,
    library_ensure_reversed, library_ensure_slideshow, library_fill_thumb, library_filter_counts,
    library_existing_creation_ids, library_get_creation, library_get_creations, library_get_folder,
    library_import_from_disk, library_import_local_paths, library_invalidate_mismatched_thumbs,
    library_invalidate_thumbs, library_list_creations, library_list_creations_page,
    library_list_filed_creation_ids, library_list_folders, library_list_group_member_ids,
    library_local_fit_plan,
    library_merge_timeline_clips, library_folder_sync_state, library_folders_ack_ops,
    library_folders_apply_snapshot, library_folders_set_pending_ops,
    library_extend_clip, library_extract_video_frame, library_slice_audio, library_separate_vocals,
    library_cached_full_vocals,
    library_audio_waveform_peaks,
    library_prepare_openai_whisper_audio, library_read_file_base64,
    library_install_demucs, library_lab_deps_status, library_open_local_tools_doc,
    library_transcribe_local,
    library_read_local_thumb_base64, library_rebuild_reversed, library_remove_from_folder,
    library_rename_folder, library_sync_status, jobs_cancel, jobs_enqueue, jobs_get, jobs_list,
    publisher_delete_render, publisher_export_render,
    publisher_list_renders, publisher_render_timeline,
};
use oauth_listener::{cancel_oauth_listener, oauth_take_callback, start_oauth_listener};
use tauri::Manager;
use tauri::webview::PageLoadEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            match media_stream::media_response(request) {
                Ok(response) => responder.respond(response),
                Err(error) => {
                    let body = error.to_string().into_bytes();
                    let response = http::Response::builder()
                        .status(http::StatusCode::BAD_REQUEST)
                        .header(http::header::CONTENT_TYPE, "text/plain")
                        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(body)
                        .unwrap_or_else(|_| http::Response::new(Vec::new()));
                    responder.respond(response);
                }
            }
        })
        // Keep the window hidden until the dark HTML/CSS has painted so maximize
        // and WKWebView compositing never flash the default white surface.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                let window = webview.window();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
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
            oauth_take_callback,
            http_post_json,
            http_post_bearer,
            http_post_bytes_bearer,
            http_get_bearer,
            http_delete_bearer,
            library_ensure_ready,
            library_get_creation,
            library_get_creations,
            library_existing_creation_ids,
            library_cloud_ids_since,
            library_list_creations,
            library_list_creations_page,
            library_filter_counts,
            library_list_group_member_ids,
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
            library_ensure_clip_thumb,
            library_ensure_reversed,
            library_rebuild_reversed,
            library_detect_beats,
            library_ensure_slideshow,
            library_merge_timeline_clips,
            library_slice_audio,
            library_separate_vocals,
            library_cached_full_vocals,
            library_audio_waveform_peaks,
            library_prepare_openai_whisper_audio, library_read_file_base64,
            library_extend_clip,
            library_extract_video_frame,
            library_lab_deps_status,
            library_install_demucs,
            library_open_local_tools_doc,
            library_transcribe_local,
            library_list_folders,
            library_list_filed_creation_ids,
            library_get_folder,
            library_create_folder,
            library_rename_folder,
            library_add_to_folder,
            library_remove_from_folder,
            library_delete_folder,
            library_folder_sync_state,
            library_folders_apply_snapshot,
            library_folders_ack_ops,
            library_folders_set_pending_ops,
            jobs_enqueue,
            jobs_get,
            jobs_list,
            jobs_cancel,
            publisher_list_renders,
            publisher_render_timeline,
            publisher_delete_render,
            publisher_export_render
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
