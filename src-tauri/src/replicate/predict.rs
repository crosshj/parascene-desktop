//! Direct Replicate prediction create / poll / download for Lab runs.

use crate::replicate::cache;
use crate::replicate::client;
use crate::replicate::enabled_models;
use crate::replicate::files;
use crate::replicate::history;
use crate::replicate::token;
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

/// Bumped on cancel. Each run captures the value at start; cancel means
/// `current > my_gen`. Starting a sibling must not clear an in-flight cancel.
static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

pub fn request_cancel_run() {
    CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}

fn begin_run_generation() -> u64 {
    CANCEL_GEN.load(Ordering::SeqCst)
}

fn cancel_requested(my_gen: u64) -> bool {
    CANCEL_GEN.load(Ordering::SeqCst) > my_gen
}

fn poll_sleep_ms() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // Base 750ms + 0..400ms jitter so concurrent pollers don't stampede.
    750 + u64::from(nanos % 401)
}

/// Merge HashMap IPC + JSON string backup (Windows has dropped empty HashMaps).
pub fn merge_local_files(
    local_files: Option<HashMap<String, Value>>,
    local_files_json: Option<String>,
) -> Result<HashMap<String, Value>, String> {
    let mut map = local_files.unwrap_or_default();
    if !map.is_empty() {
        return Ok(map);
    }
    let Some(raw) = local_files_json else {
        return Ok(map);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" || trimmed == "{}" {
        return Ok(map);
    }
    let parsed: HashMap<String, Value> =
        serde_json::from_str(trimmed).map_err(|e| format!("Invalid localFilesJson: {e}"))?;
    map = parsed;
    Ok(map)
}

fn summarize_media_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                "EMPTY".into()
            } else if let Some(rest) = t.strip_prefix("data:") {
                let mime = rest.split(';').next().unwrap_or("?");
                let len = t.len();
                format!("data:{mime}:{len}b")
            } else if t.starts_with("http://") || t.starts_with("https://") {
                format!("https:{}b", t.len())
            } else {
                format!("other:{}b", t.len())
            }
        }
        Some(Value::Array(arr)) => format!("array:{}", arr.len()),
        Some(_) => "non-string".into(),
        None => "MISSING".into(),
    }
}

fn summarize_required_media(input: &Value, fields: &[String]) -> String {
    let obj = input.as_object();
    fields
        .iter()
        .map(|f| {
            let summary = summarize_media_field(obj.and_then(|o| o.get(f)));
            format!("{f}={summary}")
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgressEvent {
    pub prediction_id: Option<String>,
    pub owner: String,
    pub name: String,
    pub status: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub local_paths: Vec<String>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub prediction_id: String,
    pub owner: String,
    pub name: String,
    pub status: String,
    pub output_urls: Vec<String>,
    pub local_paths: Vec<String>,
    /// Text / JSON preview when the model does not return file URLs.
    pub output_preview: Option<String>,
    pub run_dir: String,
    pub error: Option<String>,
    /// Prefer Replicate metrics.predict_time when present.
    pub predict_time: Option<f64>,
}

fn emit_run(app: &AppHandle, ev: RunProgressEvent) {
    let _ = app.emit("replicate-run-progress", &ev);
}

fn ext_from_url(url: &str) -> &str {
    let path = url.split('?').next().unwrap_or(url);
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| {
            let lower = e.to_ascii_lowercase();
            // Reject query-ish / opaque tokens; keep common media extensions.
            e.len() <= 5
                && matches!(
                    lower.as_str(),
                    "mp4"
                        | "mov"
                        | "webm"
                        | "m4v"
                        | "mkv"
                        | "avi"
                        | "png"
                        | "jpg"
                        | "jpeg"
                        | "webp"
                        | "gif"
                        | "wav"
                        | "mp3"
                        | "m4a"
                        | "aac"
                        | "flac"
                        | "ogg"
                )
        })
        .unwrap_or("")
}

/// Prefer a real media extension so Library import does not silently skip `.bin`.
fn ext_for_output(url: &str, owner: &str, name: &str) -> String {
    let from_url = ext_from_url(url);
    if !from_url.is_empty() {
        return from_url.to_ascii_lowercase();
    }
    let blob = format!("{owner}/{name}").to_ascii_lowercase();
    if blob.contains("video")
        || blob.contains("seedance")
        || blob.contains("veo")
        || blob.contains("kling")
        || blob.contains("vidu")
        || blob.contains("wan")
        || blob.contains("aleph")
        || blob.contains("motion")
    {
        return "mp4".into();
    }
    if blob.contains("music") || blob.contains("audio") || blob.contains("lyria") {
        return "mp3".into();
    }
    if blob.contains("image") || blob.contains("flux") || blob.contains("banana") {
        return "png".into();
    }
    "mp4".into()
}

fn collect_output_urls(output: &Value) -> Vec<String> {
    match output {
        Value::String(s) if s.starts_with("http") => vec![s.clone()],
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str())
            .filter(|s| s.starts_with("http"))
            .map(|s| s.to_string())
            .collect(),
        Value::Object(map) => map.values().flat_map(collect_output_urls).collect(),
        _ => Vec::new(),
    }
}

/// Human-readable preview for text / JSON outputs (captions, embeddings, etc.).
fn output_preview(output: &Value) -> Option<String> {
    match output {
        Value::Null => None,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() || t.starts_with("http://") || t.starts_with("https://") {
                None
            } else {
                Some(s.clone())
            }
        }
        Value::Array(arr) => {
            // All strings that aren't URLs → join; else pretty JSON.
            let texts: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
            if !texts.is_empty() && texts.len() == arr.len() {
                let non_url: Vec<&str> = texts
                    .into_iter()
                    .filter(|s| !s.starts_with("http://") && !s.starts_with("https://"))
                    .collect();
                if !non_url.is_empty() {
                    return Some(non_url.join("\n"));
                }
            }
            serde_json::to_string_pretty(output).ok()
        }
        other => serde_json::to_string_pretty(other).ok(),
    }
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "canceled" | "cancelled")
}

/// Strip empty / null optional values; keep required-looking fields as provided by FE.
fn sanitize_input(input: &Value) -> Value {
    let Some(obj) = input.as_object() else {
        return input.clone();
    };
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        match v {
            Value::Null => {}
            Value::String(s) if s.trim().is_empty() => {}
            other => {
                out.insert(k.clone(), other.clone());
            }
        }
    }
    Value::Object(out)
}

fn persist(
    owner: &str,
    name: &str,
    version: &str,
    input: &Value,
    prediction: &Value,
    status_override: Option<&str>,
    output_urls: &[String],
    local_paths: &[String],
    error: Option<&str>,
) {
    let _ = history::upsert_from_prediction(
        owner,
        name,
        version,
        input,
        prediction,
        status_override,
        output_urls,
        local_paths,
        error,
    );
}

async fn download_urls_to_run_dir(
    token: &str,
    owner: &str,
    name: &str,
    run_dir: &Path,
    output_urls: &[String],
    local_paths: &mut Vec<String>,
) -> Result<(), String> {
    local_paths.clear();
    // Filesystem-safe ISO: 2026-07-29T16-57-00.123Z (colons → hyphens).
    let iso = Utc::now().format("%Y-%m-%dT%H-%M-%S%.3fZ").to_string();
    let owner_safe = safe_filename_part(owner);
    let name_safe = safe_filename_part(name);
    for (i, url) in output_urls.iter().enumerate() {
        let ext = ext_for_output(url, owner, name);
        let stem = output_filename_stem(&owner_safe, &name_safe, &iso, i, output_urls.len());
        let dest = run_dir.join(format!("{stem}.{ext}"));
        client::download_to_path(url, &dest, Some(token)).await?;
        local_paths.push(dest.to_string_lossy().to_string());
    }
    Ok(())
}

fn output_filename_stem(
    owner_safe: &str,
    name_safe: &str,
    iso: &str,
    index: usize,
    total: usize,
) -> String {
    if total == 1 {
        format!("{owner_safe}_{name_safe}_{iso}")
    } else {
        format!("{owner_safe}_{name_safe}_{iso}_{index}")
    }
}

fn safe_filename_part(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "model".into()
    } else {
        trimmed.to_string()
    }
}

/// Re-download outputs for an existing prediction (e.g. after a CDN failure).
/// Refreshes output URLs from the Replicate API when the local record has none
/// or a prior download attempt failed.
pub async fn download_prediction_outputs(
    app: AppHandle,
    prediction_id: String,
) -> Result<RunResult, String> {
    let token = token::require_token()?;
    let detail = history::get_prediction(&prediction_id)?
        .ok_or_else(|| format!("No local record for prediction {prediction_id}"))?;
    let mut record = detail.record;
    let owner = record.owner.clone();
    let name = record.name.clone();
    let version = record.version.clone().unwrap_or_default();

    // Prefer fresh URLs from the API — delivery links can expire.
    let api_url = format!("https://api.replicate.com/v1/predictions/{prediction_id}");
    let prediction = client::get_json(&token, &api_url).await?;
    let status = prediction
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if status != "succeeded" {
        let err = prediction
            .get("error")
            .and_then(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| (!v.is_null()).then(|| v.to_string()))
            })
            .unwrap_or_else(|| format!("Prediction status is {status}"));
        return Err(err);
    }
    let output = prediction.get("output").cloned().unwrap_or(Value::Null);
    let mut output_urls = collect_output_urls(&output);
    if output_urls.is_empty() {
        output_urls = record.output_urls.clone();
    }
    if output_urls.is_empty() {
        return Err("Prediction has no downloadable output URLs.".into());
    }
    let preview = output_preview(&output).or(record.output_preview.clone());
    let input = prediction
        .get("input")
        .cloned()
        .unwrap_or_else(|| record.input.clone());

    let run_dir = history::runs_dir()?.join(&prediction_id);
    std::fs::create_dir_all(&run_dir).map_err(|e| format!("Could not create run dir: {e}"))?;

    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(prediction_id.clone()),
            owner: owner.clone(),
            name: name.clone(),
            status: "downloading".into(),
            message: Some(format!(
                "Retrying download of {} output(s)…",
                output_urls.len()
            )),
            error: None,
            local_paths: Vec::new(),
            done: false,
        },
    );
    persist(
        &owner,
        &name,
        &version,
        &input,
        &prediction,
        Some("downloading"),
        &output_urls,
        &[],
        None,
    );

    let mut local_paths: Vec<String> = Vec::new();
    if let Err(e) = download_urls_to_run_dir(
        &token,
        &owner,
        &name,
        &run_dir,
        &output_urls,
        &mut local_paths,
    )
    .await
    {
        let _ = persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            Some("failed"),
            &output_urls,
            &local_paths,
            Some(&e),
        );
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id),
                owner,
                name,
                status: "failed".into(),
                message: None,
                error: Some(e.clone()),
                local_paths,
                done: true,
            },
        );
        return Err(e);
    }

    let saved = history::upsert_from_prediction_with_preview(
        &owner,
        &name,
        &version,
        &input,
        &prediction,
        Some("succeeded"),
        &output_urls,
        &local_paths,
        preview.as_deref(),
        None,
    )?;
    record = saved;

    let result = RunResult {
        prediction_id: prediction_id.clone(),
        owner: owner.clone(),
        name: name.clone(),
        status: "succeeded".into(),
        output_urls,
        local_paths: local_paths.clone(),
        output_preview: preview,
        run_dir: record.run_dir,
        error: None,
        predict_time: record.predict_time.or(record.total_time),
    };
    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(prediction_id),
            owner,
            name,
            status: "succeeded".into(),
            message: Some("Download complete.".into()),
            error: None,
            local_paths,
            done: true,
        },
    );
    Ok(result)
}

fn owner_name_from_prediction(
    prediction: &Value,
    fallback: Option<(&str, &str)>,
) -> Result<(String, String), String> {
    if let Some((o, n)) = fallback {
        let ot = o.trim();
        let nt = n.trim();
        if !ot.is_empty() && !nt.is_empty() {
            return Ok((ot.to_string(), nt.to_string()));
        }
    }
    let model = prediction
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if let Some((owner, name)) = model.split_once('/') {
        let ot = owner.trim();
        let nt = name.trim();
        if !ot.is_empty() && !nt.is_empty() {
            return Ok((ot.to_string(), nt.to_string()));
        }
    }
    Err("Could not determine model owner/name for prediction.".into())
}

/// Poll an existing prediction until terminal, then download outputs.
/// Used to resume add-asset generation after an app restart.
pub async fn wait_prediction_outputs(
    app: AppHandle,
    prediction_id: String,
) -> Result<RunResult, String> {
    let my_gen = begin_run_generation();
    let token = token::require_token()?;
    let local = history::get_prediction(&prediction_id)?.map(|d| d.record);
    let api_url = format!("https://api.replicate.com/v1/predictions/{prediction_id}");
    let mut prediction = client::get_json(&token, &api_url).await?;
    let (owner, name) = owner_name_from_prediction(
        &prediction,
        local.as_ref().map(|r| (r.owner.as_str(), r.name.as_str())),
    )?;
    let version = prediction
        .get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| local.as_ref().and_then(|r| r.version.clone()))
        .unwrap_or_default();
    let input = prediction
        .get("input")
        .cloned()
        .or_else(|| local.as_ref().map(|r| r.input.clone()))
        .unwrap_or(Value::Null);

    let mut polls = 0u32;
    loop {
        if cancel_requested(my_gen) {
            let cancel_url =
                format!("https://api.replicate.com/v1/predictions/{prediction_id}/cancel");
            let _ = client::post_json(&token, &cancel_url, &json!({})).await;
            persist(
                &owner,
                &name,
                &version,
                &input,
                &prediction,
                Some("canceled"),
                &[],
                &[],
                Some("Run cancelled."),
            );
            emit_run(
                &app,
                RunProgressEvent {
                    prediction_id: Some(prediction_id.clone()),
                    owner: owner.clone(),
                    name: name.clone(),
                    status: "canceled".into(),
                    message: Some("Run cancelled.".into()),
                    error: None,
                    local_paths: Vec::new(),
                    done: true,
                },
            );
            return Err("Run cancelled.".into());
        }

        let status = prediction
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            None,
            &[],
            &[],
            None,
        );

        if is_terminal(&status) {
            break;
        }

        polls += 1;
        if polls > 600 {
            persist(
                &owner,
                &name,
                &version,
                &input,
                &prediction,
                Some("failed"),
                &[],
                &[],
                Some("Prediction timed out after polling."),
            );
            return Err("Prediction timed out after polling.".into());
        }

        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id.clone()),
                owner: owner.clone(),
                name: name.clone(),
                status: status.clone(),
                message: Some(format!("Resuming wait ({status})…")),
                error: None,
                local_paths: Vec::new(),
                done: false,
            },
        );

        sleep(Duration::from_millis(poll_sleep_ms())).await;
        prediction = client::get_json(&token, &api_url).await?;
    }

    let status = prediction
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    if status != "succeeded" {
        let msg = prediction
            .get("error")
            .and_then(|v| {
                if v.is_null() {
                    None
                } else if let Some(s) = v.as_str() {
                    Some(s.to_string())
                } else {
                    Some(v.to_string())
                }
            })
            .unwrap_or_else(|| format!("Prediction {status}"));
        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            Some(&status),
            &[],
            &[],
            Some(&msg),
        );
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id),
                owner,
                name,
                status,
                message: None,
                error: Some(msg.clone()),
                local_paths: Vec::new(),
                done: true,
            },
        );
        return Err(msg);
    }

    download_prediction_outputs(app, prediction_id).await
}

pub async fn run_prediction(
    app: AppHandle,
    owner: String,
    name: String,
    input: Value,
    local_files: HashMap<String, Value>,
    required_file_fields: Vec<String>,
) -> Result<RunResult, String> {
    let my_gen = begin_run_generation();
    let token = token::require_token()?;
    if !enabled_models::is_enabled(&owner, &name) {
        return Err(format!(
            "Model {owner}/{name} is not enabled. Enable it in Lab before running."
        ));
    }

    let detail = cache::get_model_local(&owner, &name)?
        .ok_or_else(|| format!("Model {owner}/{name} not found in local catalog"))?;
    let version = detail
        .latest_version_id
        .clone()
        .ok_or_else(|| format!("No cached version for {owner}/{name}. Use Update model first."))?;
    if !detail.schema_cached {
        return Err(format!(
            "No schema cached for {owner}/{name}. Use Update model first."
        ));
    }

    let required_fields: Vec<String> = required_file_fields
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let received_keys: Vec<String> = {
        let mut keys: Vec<String> = local_files.keys().cloned().collect();
        keys.sort();
        keys
    };
    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: None,
            owner: owner.clone(),
            name: name.clone(),
            status: "uploading".into(),
            message: Some(if received_keys.is_empty() {
                "localFiles received: (none)".into()
            } else {
                format!("localFiles received: {}", received_keys.join(","))
            }),
            error: None,
            local_paths: Vec::new(),
            done: false,
        },
    );

    if !required_fields.is_empty() && local_files.is_empty() {
        return Err(format!(
            "localFiles empty at Rust boundary but required [{}]. Likely IPC drop — retry; diagnostics should show localFilesJson recovery.",
            required_fields.join(", ")
        ));
    }

    let mut input = sanitize_input(&input);

    // Upload local media before create — never rely on Parascene remote URLs.
    // Values: string path (scalar) or JSON array of path strings.
    if !local_files.is_empty() {
        let mut upload_total = 0usize;
        for value in local_files.values() {
            match value {
                Value::String(_) => upload_total += 1,
                Value::Array(arr) => upload_total += arr.len(),
                _ => {}
            }
        }
        let mut upload_index = 0usize;
        let mut sorted: Vec<(String, Value)> = local_files.into_iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let obj_keys_from_local: Vec<String> = sorted.iter().map(|(k, _)| k.clone()).collect();
        let mut obj = input.as_object().cloned().unwrap_or_default();

        async fn upload_one(
            token: &str,
            field: &str,
            path_trim: &str,
            upload_index: usize,
            upload_total: usize,
            app: &AppHandle,
            owner: &str,
            name: &str,
            my_gen: u64,
        ) -> Result<String, String> {
            if cancel_requested(my_gen) {
                return Err("Cancelled".into());
            }
            let label = Path::new(path_trim)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(path_trim);
            emit_run(
                app,
                RunProgressEvent {
                    prediction_id: None,
                    owner: owner.to_string(),
                    name: name.to_string(),
                    status: "uploading".into(),
                    message: Some(format!(
                        "Uploading {field} ({upload_index}/{upload_total}): {label}…"
                    )),
                    error: None,
                    local_paths: Vec::new(),
                    done: false,
                },
            );
            files::resolve_local_file_uri(token, path_trim).await
        }

        for (field, value) in sorted {
            match value {
                Value::String(path) => {
                    let path_trim = path.trim();
                    if path_trim.is_empty() {
                        return Err(format!(
                            "Replicate local file for “{field}” is empty. Refusing to create a prediction without a real file (models treat missing image inputs as '')."
                        ));
                    }
                    upload_index += 1;
                    let uri = upload_one(
                        &token,
                        &field,
                        path_trim,
                        upload_index,
                        upload_total,
                        &app,
                        &owner,
                        &name,
                        my_gen,
                    )
                    .await?;
                    if uri.trim().is_empty() {
                        return Err(format!(
                            "Replicate upload for “{field}” returned an empty URI."
                        ));
                    }
                    obj.insert(field, Value::String(uri));
                }
                Value::Array(paths) => {
                    let mut uris: Vec<Value> = Vec::new();
                    for path_v in paths {
                        let Some(path) = path_v.as_str() else {
                            return Err(format!(
                                "Replicate localFiles[“{field}”] array entry must be a path string."
                            ));
                        };
                        let path_trim = path.trim();
                        if path_trim.is_empty() {
                            return Err(format!(
                                "Replicate localFiles[“{field}”] contains an empty path."
                            ));
                        }
                        upload_index += 1;
                        let uri = upload_one(
                            &token,
                            &field,
                            path_trim,
                            upload_index,
                            upload_total,
                            &app,
                            &owner,
                            &name,
                            my_gen,
                        )
                        .await?;
                        if uri.trim().is_empty() {
                            return Err(format!(
                                "Replicate upload for “{field}” returned an empty URI."
                            ));
                        }
                        uris.push(Value::String(uri));
                    }
                    if uris.is_empty() {
                        return Err(format!(
                            "Replicate localFiles[“{field}”] produced no uploaded URIs."
                        ));
                    }
                    obj.insert(field, Value::Array(uris));
                }
                other => {
                    return Err(format!(
                        "Replicate localFiles[“{field}”] has unsupported value type ({other}). Expected a path string or array of paths."
                    ));
                }
            }
        }
        // Defense: every localFiles key must now be a non-empty URI in input.
        for field in obj_keys_from_local.iter() {
            let ok = match obj.get(field) {
                Some(Value::String(s)) => !s.trim().is_empty(),
                Some(Value::Array(arr)) => arr
                    .iter()
                    .any(|v| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)),
                _ => false,
            };
            if !ok {
                return Err(format!(
                    "Replicate input “{field}” is missing after local file upload. Refusing to create prediction (would send empty image to the model)."
                ));
            }
        }
        input = Value::Object(obj);
    }

    // Editor requires start_image (etc.) even if localFiles map was wrong somehow.
    for field in &required_fields {
        let ok = match input.get(field) {
            Some(Value::String(s)) => !s.trim().is_empty(),
            Some(Value::Array(arr)) => arr
                .iter()
                .any(|v| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)),
            _ => false,
        };
        if !ok {
            return Err(format!(
                "Required Replicate media field “{field}” is missing or empty before create. Refusing to call the model (Vidu would report start_image got '')."
            ));
        }
    }

    let media_summary = if required_fields.is_empty() {
        String::new()
    } else {
        summarize_required_media(&input, &required_fields)
    };
    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: None,
            owner: owner.clone(),
            name: name.clone(),
            status: "starting".into(),
            message: Some(if media_summary.is_empty() {
                "Creating prediction…".into()
            } else {
                format!("Predict input media: {media_summary}")
            }),
            error: None,
            local_paths: Vec::new(),
            done: false,
        },
    );

    let body = json!({
        "version": version,
        "input": input,
    });
    let mut prediction = client::post_prediction(&token, &body).await?;
    let prediction_id = prediction
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Prediction response missing id".to_string())?
        .to_string();

    persist(
        &owner,
        &name,
        &version,
        &input,
        &prediction,
        None,
        &[],
        &[],
        None,
    );

    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(prediction_id.clone()),
            owner: owner.clone(),
            name: name.clone(),
            status: prediction
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("starting")
                .to_string(),
            message: Some("Prediction created.".into()),
            error: None,
            local_paths: Vec::new(),
            done: false,
        },
    );

    // Poll until terminal (Prefer: wait may already have finished).
    let mut polls = 0u32;
    loop {
        if cancel_requested(my_gen) {
            let cancel_url =
                format!("https://api.replicate.com/v1/predictions/{prediction_id}/cancel");
            let _ = client::post_json(&token, &cancel_url, &json!({})).await;
            persist(
                &owner,
                &name,
                &version,
                &input,
                &prediction,
                Some("canceled"),
                &[],
                &[],
                Some("Run cancelled."),
            );
            emit_run(
                &app,
                RunProgressEvent {
                    prediction_id: Some(prediction_id.clone()),
                    owner: owner.clone(),
                    name: name.clone(),
                    status: "canceled".into(),
                    message: Some("Run cancelled.".into()),
                    error: None,
                    local_paths: Vec::new(),
                    done: true,
                },
            );
            return Err("Run cancelled.".into());
        }

        let status = prediction
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            None,
            &[],
            &[],
            None,
        );

        if is_terminal(&status) {
            break;
        }

        polls += 1;
        if polls > 600 {
            persist(
                &owner,
                &name,
                &version,
                &input,
                &prediction,
                Some("failed"),
                &[],
                &[],
                Some("Prediction timed out after polling."),
            );
            return Err("Prediction timed out after polling.".into());
        }

        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id.clone()),
                owner: owner.clone(),
                name: name.clone(),
                status: status.clone(),
                message: Some(format!("Waiting ({status})…")),
                error: None,
                local_paths: Vec::new(),
                done: false,
            },
        );

        sleep(Duration::from_millis(poll_sleep_ms())).await;
        let url = format!("https://api.replicate.com/v1/predictions/{prediction_id}");
        prediction = client::get_json(&token, &url).await?;
    }

    let status = prediction
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let err_msg = prediction.get("error").and_then(|v| {
        if v.is_null() {
            None
        } else if let Some(s) = v.as_str() {
            Some(s.to_string())
        } else {
            Some(v.to_string())
        }
    });

    if status != "succeeded" {
        let msg = err_msg
            .clone()
            .unwrap_or_else(|| format!("Prediction {status}"));
        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            Some(&status),
            &[],
            &[],
            Some(&msg),
        );
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id.clone()),
                owner: owner.clone(),
                name: name.clone(),
                status: status.clone(),
                message: None,
                error: Some(msg.clone()),
                local_paths: Vec::new(),
                done: true,
            },
        );
        return Err(msg);
    }

    let output = prediction.get("output").cloned().unwrap_or(Value::Null);
    let output_urls = collect_output_urls(&output);
    let preview = output_preview(&output);

    if output_urls.is_empty() && preview.is_none() && output.is_null() {
        let msg = "Prediction succeeded but returned no output.".to_string();
        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            Some("failed"),
            &[],
            &[],
            Some(&msg),
        );
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id.clone()),
                owner: owner.clone(),
                name: name.clone(),
                status: "failed".into(),
                message: None,
                error: Some(msg.clone()),
                local_paths: Vec::new(),
                done: true,
            },
        );
        return Err(msg);
    }

    let run_dir = history::runs_dir()?.join(&prediction_id);
    std::fs::create_dir_all(&run_dir).map_err(|e| format!("Could not create run dir: {e}"))?;

    // Persist raw output for text/JSON models (and as a sidecar for file models).
    if !output.is_null() {
        let out_path = run_dir.join("output.json");
        let pretty = serde_json::to_string_pretty(&output).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, pretty)
            .map_err(|e| format!("Could not write output.json: {e}"))?;
        if let Some(ref text) = preview {
            let _ = std::fs::write(run_dir.join("output.txt"), text);
        }
    }

    let mut local_paths: Vec<String> = Vec::new();
    if !output_urls.is_empty() {
        persist(
            &owner,
            &name,
            &version,
            &input,
            &prediction,
            Some("downloading"),
            &output_urls,
            &[],
            None,
        );
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(prediction_id.clone()),
                owner: owner.clone(),
                name: name.clone(),
                status: "downloading".into(),
                message: Some(format!("Downloading {} output(s)…", output_urls.len())),
                error: None,
                local_paths: Vec::new(),
                done: false,
            },
        );

        match download_urls_to_run_dir(
            &token,
            &owner,
            &name,
            &run_dir,
            &output_urls,
            &mut local_paths,
        )
        .await
        {
            Ok(()) => {}
            Err(e) => {
                let _ = persist(
                    &owner,
                    &name,
                    &version,
                    &input,
                    &prediction,
                    Some("failed"),
                    &output_urls,
                    &local_paths,
                    Some(&e),
                );
                emit_run(
                    &app,
                    RunProgressEvent {
                        prediction_id: Some(prediction_id.clone()),
                        owner: owner.clone(),
                        name: name.clone(),
                        status: "failed".into(),
                        message: None,
                        error: Some(e.clone()),
                        local_paths: local_paths.clone(),
                        done: true,
                    },
                );
                return Err(e);
            }
        }
    }

    let record = history::upsert_from_prediction_with_preview(
        &owner,
        &name,
        &version,
        &input,
        &prediction,
        Some("succeeded"),
        &output_urls,
        &local_paths,
        preview.as_deref(),
        None,
    )?;

    let result = RunResult {
        prediction_id: prediction_id.clone(),
        owner: owner.clone(),
        name: name.clone(),
        status: "succeeded".into(),
        output_urls,
        local_paths: local_paths.clone(),
        output_preview: preview,
        run_dir: record.run_dir,
        error: None,
        predict_time: record.predict_time.or(record.total_time),
    };

    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(prediction_id),
            owner,
            name,
            status: "succeeded".into(),
            message: Some("Run complete.".into()),
            error: None,
            local_paths,
            done: true,
        },
    );

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{merge_local_files, output_filename_stem, safe_filename_part};
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn merge_prefers_hashmap_when_present() {
        let mut map = HashMap::new();
        map.insert("start_image".into(), json!("/tmp/a.jpg"));
        let out = merge_local_files(
            Some(map),
            Some(r#"{"start_image":"/tmp/b.jpg"}"#.to_string()),
        )
        .expect("merge");
        assert_eq!(
            out.get("start_image").and_then(|v| v.as_str()),
            Some("/tmp/a.jpg")
        );
    }

    #[test]
    fn merge_falls_back_to_json_when_hashmap_empty() {
        let out = merge_local_files(
            Some(HashMap::new()),
            Some(r#"{"start_image":"C:\\Cache\\still.jpg"}"#.to_string()),
        )
        .expect("merge");
        assert_eq!(
            out.get("start_image").and_then(|v| v.as_str()),
            Some(r"C:\Cache\still.jpg")
        );
    }

    #[test]
    fn merge_empty_when_both_missing() {
        let out = merge_local_files(None, None).expect("merge");
        assert!(out.is_empty());
    }

    #[test]
    fn output_names_include_provider_model_and_iso() {
        assert_eq!(safe_filename_part("black-forest-labs"), "black-forest-labs");
        assert_eq!(safe_filename_part("flux/dev"), "flux_dev");
        assert_eq!(
            output_filename_stem("krea", "flux", "2026-07-29T16-57-00.123Z", 0, 1),
            "krea_flux_2026-07-29T16-57-00.123Z"
        );
        assert_eq!(
            output_filename_stem("krea", "flux", "2026-07-29T16-57-00.123Z", 1, 2),
            "krea_flux_2026-07-29T16-57-00.123Z_1"
        );
    }
}
