mod beats;
mod catalog;
mod clip_thumb;
mod download;
mod ffmpeg;
mod folders;
mod import_local;
mod jobs;
mod lab_audio;
mod lab_deps;
mod lab_transcribe;
mod merge;
mod parascene_api;
pub(crate) mod paths;
mod render;
mod reverse;
mod slideshow;
mod thumb_fill;

pub use beats::library_detect_beats;
pub use catalog::{
    library_apply_manifest, library_cloud_ids_since, library_ensure_ready,
    library_existing_creation_ids, library_filter_counts, library_get_creation,
    library_get_creations, library_invalidate_thumbs, library_list_creations,
    library_list_group_member_ids, library_sync_status,
};
pub use clip_thumb::library_ensure_clip_thumb;
pub use download::{
    library_cache_missing_media, library_cache_missing_thumbs, library_delete_local,
    library_download_ids, library_download_pending, library_download_thumbs, library_ensure_local,
    library_invalidate_mismatched_thumbs, library_local_fit_plan,
};
pub use folders::{
    library_add_to_folder, library_create_folder, library_delete_folder, library_folder_sync_state,
    library_folders_ack_ops, library_folders_apply_snapshot, library_folders_set_pending_ops,
    library_get_folder, library_list_filed_creation_ids, library_list_folders,
    library_remove_from_folder, library_rename_folder,
};
pub use import_local::{library_import_from_disk, library_import_local_paths};
pub use jobs::{jobs_cancel, jobs_enqueue, jobs_get, jobs_list};
pub use lab_audio::{
    library_audio_waveform_peaks, library_cached_full_vocals, library_extend_clip,
    library_extract_video_frame, library_prepare_openai_whisper_audio, library_read_file_base64,
    library_separate_vocals, library_slice_audio,
};
pub use lab_deps::{
    library_install_demucs, library_lab_deps_status, library_open_local_tools_doc,
};
pub use lab_transcribe::library_transcribe_local;
pub use merge::library_merge_timeline_clips;
pub use render::{
    publisher_delete_render, publisher_export_render, publisher_list_renders,
    publisher_render_timeline,
};
pub use reverse::{library_ensure_reversed, library_rebuild_reversed};
pub use slideshow::library_ensure_slideshow;
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
