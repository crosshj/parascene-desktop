use crate::blue::client;
use crate::blue::credentials::{self, CredentialsStatus};
use crate::blue::history::{self, JobDetail, JobListRow};
use crate::blue::run::{self, RunResult};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
pub fn blue_credentials_status() -> Result<CredentialsStatus, String> {
    credentials::credentials_status()
}

#[tauri::command]
pub fn blue_credentials_set(credentials_json: String) -> Result<CredentialsStatus, String> {
    credentials::set_credentials_json(credentials_json)?;
    credentials::credentials_status()
}

#[tauri::command]
pub fn blue_credentials_clear() -> Result<CredentialsStatus, String> {
    credentials::clear_credentials()?;
    credentials::credentials_status()
}

#[tauri::command]
pub async fn blue_capabilities() -> Result<Value, String> {
    let creds = credentials::require_credentials()?;
    client::get_json(&creds, "/api").await
}

#[tauri::command]
pub async fn blue_upload_file(path: String) -> Result<String, String> {
    let creds = credentials::require_credentials()?;
    client::upload_file(&creds, PathBuf::from(path).as_path()).await
}

#[tauri::command]
pub async fn blue_method_run(
    app: AppHandle,
    method: String,
    args: Value,
    local_files: Option<HashMap<String, Value>>,
    local_files_json: Option<String>,
) -> Result<RunResult, String> {
    let files = match local_files {
        Some(m) if !m.is_empty() => Some(m),
        _ => local_files_json
            .as_ref()
            .and_then(|s| serde_json::from_str::<HashMap<String, Value>>(s).ok()),
    };
    run::run_method(app, method, args, files).await
}

#[tauri::command]
pub fn blue_method_run_cancel() -> Result<(), String> {
    run::request_cancel();
    Ok(())
}

#[tauri::command]
pub fn blue_jobs_list(
    status: Option<String>,
    query: Option<String>,
) -> Result<Vec<JobListRow>, String> {
    history::list_jobs(status, query)
}

#[tauri::command]
pub fn blue_job_get(prediction_id: String) -> Result<Option<JobDetail>, String> {
    history::get_job(&prediction_id)
}

#[tauri::command]
pub async fn blue_job_wait(app: AppHandle, prediction_id: String) -> Result<RunResult, String> {
    run::wait_job(app, prediction_id).await
}

#[tauri::command]
pub async fn blue_job_download(app: AppHandle, prediction_id: String) -> Result<RunResult, String> {
    run::redownload_job(app, prediction_id).await
}

#[tauri::command]
pub fn blue_job_delete(prediction_id: String) -> Result<(), String> {
    history::delete_job(&prediction_id)
}
