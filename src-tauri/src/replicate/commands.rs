use crate::replicate::cache::{self, CacheStats, ModelDetailDto, ModelListPage};
use crate::replicate::enabled_models;
use crate::replicate::files;
use crate::replicate::history::{self, PredictionDetail, PredictionListRow};
use crate::replicate::jobs;
use crate::replicate::predict::{self, RunResult};
use crate::replicate::token::{self, TokenStatus};
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

#[tauri::command]
pub fn replicate_token_status() -> Result<TokenStatus, String> {
    token::token_status()
}

#[tauri::command]
pub fn replicate_token_set(token: String) -> Result<TokenStatus, String> {
    token::set_token(token)?;
    token::token_status()
}

#[tauri::command]
pub fn replicate_token_clear() -> Result<TokenStatus, String> {
    token::clear_token()?;
    token::token_status()
}

#[tauri::command]
pub fn replicate_cache_stats() -> Result<CacheStats, String> {
    cache::cache_stats(jobs::is_crawl_running())
}

#[tauri::command]
pub fn replicate_models_list_cached(
    query: Option<String>,
    features: Option<Vec<String>>,
    sort: Option<String>,
    enabled: Option<String>,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<ModelListPage, String> {
    cache::list_cached(query, features, sort, enabled, offset.unwrap_or(0), limit)
}

#[tauri::command]
pub fn replicate_model_get(owner: String, name: String) -> Result<Option<ModelDetailDto>, String> {
    cache::get_model_local(&owner, &name)
}

#[tauri::command]
pub fn replicate_model_set_enabled(
    owner: String,
    name: String,
    enabled: bool,
) -> Result<ModelDetailDto, String> {
    enabled_models::set_enabled(&owner, &name, enabled)?;
    cache::get_model_local(&owner, &name)?
        .ok_or_else(|| format!("Model {owner}/{name} not found in local catalog"))
}

#[tauri::command]
pub fn replicate_models_list_enabled() -> Result<Vec<String>, String> {
    enabled_models::list_enabled()
}

#[tauri::command]
pub async fn replicate_models_crawl_start(
    app: AppHandle,
    resume: Option<bool>,
) -> Result<CacheStats, String> {
    let resume = resume.unwrap_or(false);
    // Spawn so the invoke returns after kickoff… actually we await the full job
    // for simplicity; progress events keep the UI live. For very long crawls the
    // FE should treat this as fire-and-forget via a separate pattern — spawn task.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = jobs::run_full_crawl(app2, resume).await;
    });
    // Brief yield so RUNNING flag is set.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    cache::cache_stats(jobs::is_crawl_running())
}

#[tauri::command]
pub fn replicate_models_crawl_pause() -> Result<CacheStats, String> {
    jobs::request_pause();
    cache::cache_stats(jobs::is_crawl_running())
}

#[tauri::command]
pub fn replicate_models_crawl_cancel() -> Result<CacheStats, String> {
    jobs::request_cancel();
    // Mark checkpoint cancelled on disk if not running.
    if !jobs::is_crawl_running() {
        let dir = cache::replicate_dir()?;
        let mut cp = cache::load_checkpoint(&dir);
        cp.status = cache::CrawlStatus::Idle;
        cp.resumable = false;
        cp.next_url = None;
        cp.phase = "cancelled".into();
        cp.updated_at = Some(cache::now_millis());
        cache::save_checkpoint(&dir, &cp)?;
    }
    cache::cache_stats(jobs::is_crawl_running())
}

#[tauri::command]
pub async fn replicate_models_check_new(app: AppHandle) -> Result<CacheStats, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = jobs::run_check_new(app2).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    cache::cache_stats(jobs::is_crawl_running())
}

#[tauri::command]
pub async fn replicate_model_update(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<ModelDetailDto, String> {
    jobs::update_model(app, owner, name).await
}

#[tauri::command]
pub async fn replicate_model_run(
    app: AppHandle,
    owner: String,
    name: String,
    input: Value,
    local_files: Option<HashMap<String, Value>>,
    // JSON object backup of local file paths — used when HashMap IPC arrives empty.
    local_files_json: Option<String>,
    // Field names that must be present as non-empty URIs after upload (e.g. start_image).
    required_file_fields: Option<Vec<String>>,
) -> Result<RunResult, String> {
    let files = predict::merge_local_files(local_files, local_files_json)?;
    predict::run_prediction(
        app,
        owner,
        name,
        input,
        files,
        required_file_fields.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub fn replicate_model_run_cancel() -> Result<(), String> {
    predict::request_cancel_run();
    Ok(())
}

/// OS file dialog for a Replicate URI input. `kind`: image | audio | video | any.
#[tauri::command]
pub fn replicate_pick_local_file(kind: Option<String>) -> Result<Option<String>, String> {
    files::pick_local_file(kind.as_deref().unwrap_or("any"))
}

#[tauri::command]
pub async fn replicate_prediction_download(
    app: AppHandle,
    prediction_id: String,
) -> Result<RunResult, String> {
    predict::download_prediction_outputs(app, prediction_id).await
}

/// Poll an existing prediction until terminal, then download outputs (app-restart resume).
#[tauri::command]
pub async fn replicate_prediction_wait(
    app: AppHandle,
    prediction_id: String,
) -> Result<RunResult, String> {
    predict::wait_prediction_outputs(app, prediction_id).await
}

#[tauri::command]
pub async fn replicate_predictions_list(
    status: Option<String>,
    query: Option<String>,
) -> Result<Vec<PredictionListRow>, String> {
    tokio::task::spawn_blocking(move || history::list_predictions(status, query))
        .await
        .map_err(|e| format!("Predictions list task failed: {e}"))?
}

#[tauri::command]
pub async fn replicate_prediction_get(
    prediction_id: String,
) -> Result<Option<PredictionDetail>, String> {
    tokio::task::spawn_blocking(move || history::get_prediction(&prediction_id))
        .await
        .map_err(|e| format!("Prediction get task failed: {e}"))?
}

#[tauri::command]
pub async fn replicate_prediction_delete(prediction_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || history::delete_prediction(&prediction_id))
        .await
        .map_err(|e| format!("Prediction delete task failed: {e}"))?
}
