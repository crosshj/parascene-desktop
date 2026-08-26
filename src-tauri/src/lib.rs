mod auth_store;
mod blue;
mod clipboard;
mod http_client;
mod library;
mod media_stream;
mod oauth_listener;
mod replicate;
mod service;
mod user_avatar;

use auth_store::{auth_ensure_access_token, keychain_delete, keychain_get, keychain_set};
use blue::{
    blue_capabilities, blue_credentials_clear, blue_credentials_set, blue_credentials_status,
    blue_job_delete, blue_job_download, blue_job_get, blue_job_wait, blue_jobs_list,
    blue_method_run, blue_method_run_cancel, blue_upload_file,
};
use clipboard::clipboard_write_text;
use http_client::{
    http_delete_bearer, http_get_bearer, http_post_bearer, http_post_bytes_bearer, http_post_json,
};
use library::{
    jobs_cancel, jobs_enqueue, jobs_get, jobs_list, library_add_existing_project_asset,
    library_add_project_assets, library_add_to_folder, library_append_diag_log,
    library_apply_image_framing, library_apply_manifest, library_audio_waveform_peaks,
    library_bake_plate_still, library_bake_timeline_audio, library_bake_timeline_fragment, library_cache_composition_run, library_cache_missing_media,
    library_cache_missing_thumbs, library_cached_full_vocals, library_check_creation_usage,
    library_cloud_ids_since, library_create_folder, library_delete_composition_run,
    library_clear_timeline_fragments, library_concat_timeline_fragments,
    library_delete_creation_checked, library_delete_extend_cache_file, library_delete_folder,
    library_delete_local, library_delete_project, library_delete_project_asset,
    library_delete_timeline_audio_bake, library_detect_beats, library_download_ids, library_download_pending, library_download_thumbs,
    library_ensure_clip_thumb, library_ensure_local, library_ensure_ready, library_ensure_reversed,
    library_ensure_slideshow, library_existing_creation_ids, library_extend_clip,
    library_extract_video_frame, library_fill_thumb, library_filter_counts,
    library_folder_sync_state, library_folders_ack_ops, library_folders_apply_snapshot,
    library_folders_set_pending_ops, library_get_creation, library_get_creations,
    library_get_folder, library_get_project_bound_folder, library_get_project_folder,
    library_import_from_disk, library_import_local_paths, library_import_project_asset_paths,
    library_install_demucs, library_invalidate_mismatched_thumbs, library_invalidate_thumbs,
    library_join_bake, library_join_preview, library_lab_deps_status,
    library_liberate_orphan_project_folders, library_list_creations, library_list_creations_page,
    library_list_filed_creation_ids, library_list_filter_creations, library_list_folders,
    library_list_group_member_ids, library_list_project_asset_ids, library_local_fit_plan,
    library_mark_project_usage_stale, library_merge_timeline_clips, library_open_local_tools_doc,
    library_prepare_openai_whisper_audio, library_provision_project_folder,
    library_read_file_base64, library_read_local_thumb_base64, library_rebuild_reversed,
    library_reconcile_legacy_project_folder, library_release_orphan_project_folder,
    library_remove_from_folder, library_remove_project_assets, library_rename_folder,
    library_rename_project, library_repair_project_usage, library_replace_project_usage,
    library_separate_vocals, library_set_folder_cover, library_set_project_bound_folder,
    library_slice_audio, library_sync_status, library_transcribe_local, publisher_delete_render,
    publisher_export_render, publisher_export_render_audio, publisher_get_render,
    publisher_list_renders, publisher_render_timeline,
};
use oauth_listener::{cancel_oauth_listener, oauth_take_callback, start_oauth_listener};
use replicate::{
    replicate_cache_stats, replicate_model_get, replicate_model_run, replicate_model_run_cancel,
    replicate_model_set_enabled, replicate_model_update, replicate_models_check_new,
    replicate_models_crawl_cancel, replicate_models_crawl_pause, replicate_models_crawl_start,
    replicate_models_list_cached, replicate_models_list_enabled, replicate_pick_local_file,
    replicate_prediction_delete, replicate_prediction_download, replicate_prediction_get,
    replicate_prediction_wait, replicate_predictions_list, replicate_token_clear,
    replicate_token_set, replicate_token_status,
};
use service::{
    service_cancel, service_describe, service_get, service_invoke, service_list, service_list_runs,
};
use tauri::webview::PageLoadEvent;
use tauri::Emitter;
use tauri::Manager;
use user_avatar::auth_ensure_user_avatar;

/// Bring the main window forward (post-auth deep link, second-instance launch).
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        {
            let _ = app.show();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be first: second launches (incl. parascene:// after browser auth)
    // notify this process and exit instead of opening another window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            // File I/O must not run on the WebView/UI thread — sync reads here
            // beachball the OS when Publisher mounts a large scratch MP4.
            std::thread::spawn(move || match media_stream::media_response(request) {
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
            });
        })
        // Keep the window hidden until the dark HTML/CSS has painted so maximize
        // and WKWebView compositing never flash the default white surface.
        // On macOS, show + immediate set_focus often loses the activation race to
        // the parent terminal/IDE (esp. under `tauri dev`), so the first click can
        // land on another app. Re-assert focus after a short delay.
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                let window = webview.window();
                let app = webview.app_handle().clone();
                let _ = window.show();
                #[cfg(target_os = "macos")]
                {
                    let _ = app.show();
                }
                let _ = window.set_focus();
                let window_again = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    let _ = window_again.set_focus();
                });
            }
        })
        .setup(|app| {
            #[cfg(windows)]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }

            // Deep link (parascene://…) just focuses the window after browser return.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                // Native Help menu is macOS-only (system menu bar). On Windows it
                // paints an ugly classic menu strip; those actions live in the
                // account menu + keyboard shortcuts instead.
                //
                // Edit must stay in the menu bar: on macOS, Cmd+C/V/X/A/Z for
                // webview inputs only work when the matching PredefinedMenuItems
                // exist (replacing the default menu with Help-only broke them).
                #[cfg(target_os = "macos")]
                {
                    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

                    let undo = PredefinedMenuItem::undo(app, None)?;
                    let redo = PredefinedMenuItem::redo(app, None)?;
                    let edit_sep = PredefinedMenuItem::separator(app)?;
                    let cut = PredefinedMenuItem::cut(app, None)?;
                    let copy = PredefinedMenuItem::copy(app, None)?;
                    let paste = PredefinedMenuItem::paste(app, None)?;
                    let select_all = PredefinedMenuItem::select_all(app, None)?;
                    let edit = Submenu::with_items(
                        app,
                        "Edit",
                        true,
                        &[&undo, &redo, &edit_sep, &cut, &copy, &paste, &select_all],
                    )?;

                    let check_updates = MenuItem::with_id(
                        app,
                        "check_updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?;
                    let diagnose = MenuItem::with_id(
                        app,
                        "diagnose_ui",
                        "Diagnose UI Freeze…",
                        true,
                        Some("CmdOrCtrl+Shift+D"),
                    )?;
                    let unlock = MenuItem::with_id(
                        app,
                        "unlock_ui",
                        "Unlock UI",
                        true,
                        Some("CmdOrCtrl+Shift+U"),
                    )?;
                    let help = Submenu::with_items(
                        app,
                        "Help",
                        true,
                        &[&check_updates, &diagnose, &unlock],
                    )?;
                    let menu = Menu::with_items(app, &[&edit, &help])?;
                    app.set_menu(menu)?;

                    let handle = app.handle().clone();
                    app.on_menu_event(move |_app, event| match event.id().as_ref() {
                        "check_updates" => {
                            let _ = handle.emit("parascene:check-updates", ());
                        }
                        "diagnose_ui" => {
                            let _ = handle.emit("parascene:ui-diagnose", ());
                        }
                        "unlock_ui" => {
                            let _ = handle.emit("parascene:ui-unlock", ());
                        }
                        _ => {}
                    });
                }

                let handle = app.handle().clone();
                let _ = app.deep_link().on_open_url(move |_event| {
                    focus_main_window(&handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain_get,
            keychain_set,
            keychain_delete,
            auth_ensure_access_token,
            auth_ensure_user_avatar,
            start_oauth_listener,
            cancel_oauth_listener,
            oauth_take_callback,
            http_post_json,
            http_post_bearer,
            http_post_bytes_bearer,
            http_get_bearer,
            http_delete_bearer,
            library_ensure_ready,
            library_append_diag_log,
            library_get_creation,
            library_get_creations,
            library_existing_creation_ids,
            library_cloud_ids_since,
            library_list_creations,
            library_list_creations_page,
            library_list_filter_creations,
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
            library_import_project_asset_paths,
            library_reconcile_legacy_project_folder,
            library_provision_project_folder,
            library_get_project_folder,
            library_rename_project,
            library_set_project_bound_folder,
            library_get_project_bound_folder,
            library_list_project_asset_ids,
            library_delete_project_asset,
            library_delete_project,
            library_liberate_orphan_project_folders,
            library_release_orphan_project_folder,
            library_add_existing_project_asset,
            library_add_project_assets,
            library_remove_project_assets,
            library_mark_project_usage_stale,
            library_replace_project_usage,
            library_repair_project_usage,
            library_check_creation_usage,
            library_delete_creation_checked,
            library_cache_composition_run,
            library_delete_composition_run,
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
            library_bake_plate_still,
            library_bake_timeline_audio,
            library_bake_timeline_fragment,
            library_concat_timeline_fragments,
            library_clear_timeline_fragments,
            library_delete_timeline_audio_bake,
            library_merge_timeline_clips,
            library_join_preview,
            library_join_bake,
            library_slice_audio,
            library_separate_vocals,
            library_cached_full_vocals,
            library_audio_waveform_peaks,
            library_prepare_openai_whisper_audio,
            library_read_file_base64,
            library_extend_clip,
            library_delete_extend_cache_file,
            library_extract_video_frame,
            library_apply_image_framing,
            library_lab_deps_status,
            library_install_demucs,
            library_open_local_tools_doc,
            library_transcribe_local,
            library_list_folders,
            library_list_filed_creation_ids,
            library_get_folder,
            library_create_folder,
            library_rename_folder,
            library_set_folder_cover,
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
            service_list,
            service_describe,
            service_invoke,
            service_get,
            service_cancel,
            service_list_runs,
            publisher_list_renders,
            publisher_get_render,
            publisher_render_timeline,
            publisher_delete_render,
            publisher_export_render,
            publisher_export_render_audio,
            clipboard_write_text,
            replicate_token_status,
            replicate_token_set,
            replicate_token_clear,
            replicate_cache_stats,
            replicate_models_list_cached,
            replicate_model_get,
            replicate_model_set_enabled,
            replicate_models_list_enabled,
            replicate_models_crawl_start,
            replicate_models_crawl_pause,
            replicate_models_crawl_cancel,
            replicate_models_check_new,
            replicate_model_update,
            replicate_model_run,
            replicate_model_run_cancel,
            replicate_pick_local_file,
            replicate_predictions_list,
            replicate_prediction_get,
            replicate_prediction_delete,
            replicate_prediction_download,
            replicate_prediction_wait,
            blue_credentials_status,
            blue_credentials_set,
            blue_credentials_clear,
            blue_capabilities,
            blue_upload_file,
            blue_method_run,
            blue_method_run_cancel,
            blue_jobs_list,
            blue_job_get,
            blue_job_wait,
            blue_job_download,
            blue_job_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
