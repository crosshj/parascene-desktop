mod account;
mod beats;
mod catalog;
pub(crate) mod clip_thumb;
mod cloud_repair;
mod crt_gpu;
mod diag;
mod download;
pub(crate) mod ffmpeg;
mod folders;
mod import_local;
mod jobs;
mod join;
mod lab_audio;
mod lab_deps;
mod lab_transcribe;
mod looks;
mod merge;
mod parascene_api;
pub(crate) mod paths;
mod plate;
mod project_assets;
mod render;
mod reverse;
mod slideshow;
mod sync_full;
mod sync_newest;
mod sync_refresh;
mod thumb_fill;
mod preview_scheduler;
mod timeline_fragments;
mod user_state;

pub use account::{
    account_hydrate, account_login, account_logout, account_restore_secrets, account_startup,
};
pub use beats::library_detect_beats;
pub use catalog::{
    current_sync_status, library_apply_manifest, library_cloud_ids_since, library_ensure_ready,
    library_existing_creation_ids, library_filter_counts, library_get_creation,
    library_get_creations, library_invalidate_thumbs, library_list_creations,
    library_list_filter_creations, library_list_group_member_ids, library_sync_status,
};
pub use clip_thumb::library_ensure_clip_thumb;
pub use diag::library_append_diag_log;
pub use download::{
    library_cache_missing_media, library_cache_missing_thumbs, library_clear_synced_local,
    library_delete_local, library_download_ids, library_download_pending, library_download_thumbs,
    library_ensure_local, library_invalidate_mismatched_thumbs, library_local_fit_plan,
};
pub use folders::{
    current_folder_snapshot, library_add_to_folder, library_create_folder, library_delete_folder,
    library_folder_sync_state,
    library_folders_ack_ops, library_folders_apply_snapshot, library_folders_set_pending_ops,
    library_get_folder, library_list_filed_creation_ids, library_list_folders,
    library_remove_from_folder, library_rename_folder, library_set_folder_cover,
};
pub use import_local::{library_import_from_disk, library_import_local_paths};
pub use jobs::{jobs_cancel, jobs_enqueue, jobs_get, jobs_list, EnqueueJobRequest, Job};
pub use join::{library_join_bake, library_join_preview};
pub use lab_audio::{
    library_apply_image_framing, library_audio_waveform_peaks, library_cached_full_vocals,
    library_delete_extend_cache_file, library_extend_clip, library_extract_video_frame,
    library_prepare_openai_whisper_audio, library_read_file_base64, library_separate_vocals,
    library_slice_audio,
};
pub use lab_deps::{library_install_demucs, library_lab_deps_status, library_open_local_tools_doc};
pub use lab_transcribe::library_transcribe_local;
pub use merge::library_merge_timeline_clips;
pub use parascene_api::{
    delete_audio_clip, delete_creation, get_creation, get_credits, get_library_folders,
    group_creations, mutate_library_folders, record_audio_clip, ungroup_creations,
    upload_ephemeral_still, upload_fit_thumbnail, upload_generic_image,
};
pub use plate::{
    library_bake_plate_still, library_cache_composition_run, library_delete_composition_run,
};
pub use project_assets::{
    library_add_existing_project_asset, library_add_project_assets, library_check_creation_usage,
    library_delete_creation_checked, library_delete_project, library_delete_project_asset,
    library_get_project_bound_folder, library_get_project_folder,
    library_import_project_asset_paths, library_liberate_orphan_project_folders,
    library_list_project_asset_ids, library_mark_project_usage_stale,
    library_provision_project_folder, library_reconcile_legacy_project_folder,
    library_release_orphan_project_folder, library_remove_project_assets, library_rename_project,
    library_repair_project_usage, library_replace_project_usage, library_set_project_bound_folder,
};
pub use render::{
    library_bake_timeline_audio, library_delete_timeline_audio_bake, publisher_delete_render,
    publisher_export_render, publisher_export_render_audio, publisher_get_render,
    publisher_list_renders, publisher_render_timeline,
};
pub use timeline_fragments::{
    library_bake_timeline_fragment, library_clear_timeline_fragments,
    library_concat_timeline_fragments, library_preview_lease_acquire,
    library_preview_lease_release, library_read_timeline_preview_config,
    library_read_timeline_preview_snapshot,
};
pub use reverse::{library_ensure_reversed, library_rebuild_reversed};
pub use slideshow::library_ensure_slideshow;
pub use sync_refresh::run_refresh_creations_by_id;
pub use thumb_fill::{library_fill_thumb, library_read_local_thumb_base64};

use catalog::{query_creations_page, CreationPage};

/// List a page from local SQLite. No downloads — Sync / generate own the network.
#[tauri::command]
pub async fn library_list_creations_page(limit: u32, offset: u32) -> Result<CreationPage, String> {
    tauri::async_runtime::spawn_blocking(move || query_creations_page(limit, offset))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(debug_assertions)]
pub(crate) use catalog::{auth_kv_delete, auth_kv_get, auth_kv_set};
pub(crate) use user_state::mirror_live_secret;
