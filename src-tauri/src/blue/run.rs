//! Blue-direct Lab run: upload local files → POST /api → poll → download → local history.

use crate::blue::client::{self, BlueHttpResponse};
use crate::blue::credentials;
use crate::blue::history::{self, JobRecord};
use crate::library::ffmpeg;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::time::sleep;

static CANCEL_GEN: AtomicU64 = AtomicU64::new(0);

pub fn request_cancel() {
    CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
}

fn cancel_ticket() -> u64 {
    CANCEL_GEN.load(Ordering::SeqCst)
}

fn is_cancelled(my_gen: u64) -> bool {
    CANCEL_GEN.load(Ordering::SeqCst) > my_gen
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
    pub output_preview: Option<String>,
    pub run_dir: String,
    pub error: Option<String>,
    /// Wall-clock seconds for this Lab run (submit → outputs ready).
    pub predict_time: Option<f64>,
}

fn emit_run(app: &AppHandle, ev: RunProgressEvent) {
    let _ = app.emit("blue-run-progress", &ev);
}

fn now_iso() -> String {
    // RFC3339-ish without chrono crate dependency.
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms}")
}

fn method_from_name(name: &str) -> String {
    name.trim().to_string()
}

fn field_expects_image(field: &str) -> bool {
    let f = field.to_ascii_lowercase();
    f.contains("image") || f.ends_with("_images")
}

/// Re-encode stills to a baseline JPEG ComfyUI/PIL can open reliably.
/// Asset picks often land as PNG/HEIC/WebP; timeline frames already go through
/// the clip-thumb JPEG path — keep Blue uploads consistent either way.
fn prepare_local_path_for_blue(path: &Path, field: &str) -> Result<PathBuf, String> {
    if !path.is_file() {
        return Err(format!(
            "Local file missing for Blue upload ({field}): {}",
            path.display()
        ));
    }
    let len = std::fs::metadata(path)
        .map(|m| m.len())
        .map_err(|e| format!("Stat failed for Blue upload ({field}): {e}"))?;
    if len == 0 {
        return Err(format!(
            "Local file is empty for Blue upload ({field}): {}",
            path.display()
        ));
    }
    if !field_expects_image(field) {
        return Ok(path.to_path_buf());
    }

    let ffmpeg_bin = ffmpeg::resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to prepare stills for Blue. Install with: brew install ffmpeg"
            .to_string()
    })?;
    let dir = env::temp_dir().join("parascene-blue-uploads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Blue upload cache dir: {e}"))?;
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("still");
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(48)
        .collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("{safe}-{stamp}.jpg"));
    let dest_arg = dest.to_string_lossy().to_string();
    let src_arg = path.to_string_lossy().to_string();
    let output = ffmpeg::command(&ffmpeg_bin)
        .args([
            "-y",
            "-i",
            &src_arg,
            "-an",
            "-frames:v",
            "1",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            "-q:v",
            "2",
            "-update",
            "1",
            &dest_arg,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Could not prepare still for Blue: {e}"))?;
    if !output.status.success()
        || !dest.is_file()
        || dest.metadata().map(|m| m.len() == 0).unwrap_or(true)
    {
        let err = String::from_utf8_lossy(&output.stderr);
        let tail: String = err
            .chars()
            .rev()
            .take(400)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        return Err(format!(
            "Could not prepare still for Blue upload ({field}). {tail}"
        ));
    }
    Ok(dest)
}

async fn resolve_local_files_into_args(
    creds: &credentials::BlueCredentials,
    args: &mut Value,
    local_files: &HashMap<String, Value>,
    app: &AppHandle,
    method: &str,
    my_gen: u64,
) -> Result<(), String> {
    let obj = args
        .as_object_mut()
        .ok_or_else(|| "Blue args must be a JSON object".to_string())?;
    for (field, val) in local_files {
        if is_cancelled(my_gen) {
            return Err("Cancelled".into());
        }
        match val {
            Value::String(path) if !path.trim().is_empty() => {
                emit_run(
                    app,
                    RunProgressEvent {
                        prediction_id: None,
                        owner: "blue".into(),
                        name: method.into(),
                        status: "uploading".into(),
                        message: Some(format!("Uploading {field}…")),
                        error: None,
                        local_paths: vec![],
                        done: false,
                    },
                );
                let prepared = prepare_local_path_for_blue(Path::new(path), field)?;
                let url = client::upload_file(creds, prepared.as_path()).await?;
                obj.insert(field.clone(), Value::String(url));
            }
            Value::Array(items) => {
                let mut urls = Vec::new();
                for (i, item) in items.iter().enumerate() {
                    let Some(path) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                        continue;
                    };
                    if is_cancelled(my_gen) {
                        return Err("Cancelled".into());
                    }
                    emit_run(
                        app,
                        RunProgressEvent {
                            prediction_id: None,
                            owner: "blue".into(),
                            name: method.into(),
                            status: "uploading".into(),
                            message: Some(format!("Uploading {field}[{i}]…")),
                            error: None,
                            local_paths: vec![],
                            done: false,
                        },
                    );
                    let prepared = prepare_local_path_for_blue(Path::new(path), field)?;
                    urls.push(Value::String(
                        client::upload_file(creds, prepared.as_path()).await?,
                    ));
                }
                if !urls.is_empty() {
                    obj.insert(field.clone(), Value::Array(urls));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn guess_ext_for_method(method: &str, ct: &str) -> String {
    let from_ct = client::ext_for_content_type(ct);
    if from_ct != "bin" {
        return from_ct.to_string();
    }
    let m = method.to_ascii_lowercase();
    if m.contains("video") {
        "mp4".into()
    } else if m.contains("audio") {
        "mp3".into()
    } else {
        "png".into()
    }
}

async fn save_binary_output(
    run_dir: &Path,
    method: &str,
    resp: &BlueHttpResponse,
) -> Result<PathBuf, String> {
    let ext = guess_ext_for_method(method, &resp.content_type);
    let dest = run_dir.join(format!("output.{ext}"));
    tokio::fs::write(&dest, &resp.bytes)
        .await
        .map_err(|e| format!("Write output: {e}"))?;
    Ok(dest)
}

async fn poll_until_done(
    creds: &credentials::BlueCredentials,
    method: &str,
    job_id: &str,
    app: &AppHandle,
    my_gen: u64,
    started: Instant,
) -> Result<(String, Vec<String>, Vec<String>, Option<String>), String> {
    let mut attempt = 0u32;
    loop {
        if is_cancelled(my_gen) {
            return Err("Cancelled".into());
        }
        attempt += 1;
        let wait = Duration::from_millis((800u64).saturating_mul(attempt.min(8) as u64));
        sleep(wait).await;

        emit_run(
            app,
            RunProgressEvent {
                prediction_id: Some(job_id.into()),
                owner: "blue".into(),
                name: method.into(),
                status: "processing".into(),
                message: Some(format!("Polling job ({attempt})…")),
                error: None,
                local_paths: vec![],
                done: false,
            },
        );

        let body = json!({
            "method": method,
            "args": { "job_id": job_id }
        });
        let resp = client::post_json(creds, "/api", &body).await?;

        if resp.status == 202 {
            continue;
        }
        if resp.status == 404 {
            return Err(format!("Blue job not found: {job_id}"));
        }
        if resp.status == 410 {
            let msg = resp
                .json()
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| "Output data removed (retention TTL expired).".into());
            return Err(msg);
        }
        if !(200..300).contains(&resp.status) {
            let text = String::from_utf8_lossy(&resp.bytes).to_string();
            return Err(format!("Blue poll HTTP {}: {text}", resp.status));
        }

        if resp.is_binary_media() {
            let run_dir = history::ensure_run_dir(job_id)?;
            let path = save_binary_output(&run_dir, method, &resp).await?;
            let local = path.to_string_lossy().to_string();
            let _elapsed = started.elapsed().as_secs_f64();
            return Ok(("succeeded".into(), vec![], vec![local], None));
        }

        let data = resp.json()?;
        let status = data
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("succeeded")
            .to_string();
        if status == "failed" {
            let err = data
                .get("error")
                .and_then(|e| e.as_str())
                .or_else(|| {
                    data.get("result")
                        .and_then(|r| r.get("error"))
                        .and_then(|e| e.as_str())
                })
                .unwrap_or("Blue job failed")
                .to_string();
            return Err(err);
        }
        if status == "pending" || status == "running" {
            continue;
        }

        // JSON success — maybe nested URL(s).
        let mut urls = Vec::new();
        if let Some(u) = data.get("url").and_then(|x| x.as_str()) {
            urls.push(u.to_string());
        }
        if let Some(arr) = data.get("urls").and_then(|x| x.as_array()) {
            for u in arr {
                if let Some(s) = u.as_str() {
                    urls.push(s.to_string());
                }
            }
        }
        if let Some(result) = data.get("result") {
            if let Some(u) = result.get("url").and_then(|x| x.as_str()) {
                urls.push(u.to_string());
            }
            if let Some(u) = result.get("video_url").and_then(|x| x.as_str()) {
                urls.push(u.to_string());
            }
            if let Some(u) = result.get("image_url").and_then(|x| x.as_str()) {
                urls.push(u.to_string());
            }
        }

        let run_dir = history::ensure_run_dir(job_id)?;
        let mut local_paths = Vec::new();
        for (i, url) in urls.iter().enumerate() {
            if is_cancelled(my_gen) {
                return Err("Cancelled".into());
            }
            let ext = guess_ext_for_method(method, "");
            let dest = run_dir.join(format!("output-{i}.{ext}"));
            client::download_to_path(creds, url, &dest).await?;
            local_paths.push(dest.to_string_lossy().to_string());
        }

        let preview = if local_paths.is_empty() {
            Some(data.to_string())
        } else {
            None
        };
        return Ok((status, urls, local_paths, preview));
    }
}

pub async fn run_method(
    app: AppHandle,
    method: String,
    mut args: Value,
    local_files: Option<HashMap<String, Value>>,
) -> Result<RunResult, String> {
    let my_gen = cancel_ticket();
    let method = method_from_name(&method);
    if method.is_empty() {
        return Err("Missing Blue method id".into());
    }
    let creds = credentials::require_credentials()?;
    let started = Instant::now();

    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: None,
            owner: "blue".into(),
            name: method.clone(),
            status: "starting".into(),
            message: Some("Preparing Blue job…".into()),
            error: None,
            local_paths: vec![],
            done: false,
        },
    );

    if let Some(files) = local_files.as_ref() {
        resolve_local_files_into_args(&creds, &mut args, files, &app, &method, my_gen).await?;
    }

    // Strip empty job_id if present.
    if let Some(obj) = args.as_object_mut() {
        if obj
            .get("job_id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(false)
        {
            obj.remove("job_id");
        }
    }

    let create_body = json!({ "method": method, "args": args });
    let create_resp = client::post_json(&creds, "/api", &create_body).await?;
    if create_resp.status == 401 {
        return Err(
            "Unauthorized: Blue token or Cloudflare Access credentials invalid or missing.".into(),
        );
    }
    if create_resp.status != 202 && !(200..300).contains(&create_resp.status) {
        let text = String::from_utf8_lossy(&create_resp.bytes).to_string();
        if text.contains("open '") || text.contains("open \"") {
            return Err(format!(
                "Blue create HTTP {}: {text}\n\nBlue/Comfy could not open the uploaded start still. Try again (uploads are now re-encoded to a clean JPEG), or switch model to LTX / Wan to isolate a MiniMax-specific issue.",
                create_resp.status
            ));
        }
        return Err(format!("Blue create HTTP {}: {text}", create_resp.status));
    }

    // Immediate binary (unlikely) or JSON with job_id.
    if create_resp.is_binary_media() && create_resp.status == 200 {
        let job_id = format!("sync_{}", now_iso());
        let run_dir = history::ensure_run_dir(&job_id)?;
        let path = save_binary_output(&run_dir, &method, &create_resp).await?;
        let local = path.to_string_lossy().to_string();
        let record = JobRecord {
            job_id: job_id.clone(),
            owner: "blue".into(),
            name: method.clone(),
            version: args
                .get("model")
                .and_then(|m| m.as_str())
                .map(str::to_string),
            status: "succeeded".into(),
            input: args.clone(),
            output_urls: vec![],
            local_paths: vec![local.clone()],
            output_preview: None,
            error: None,
            created_at: Some(now_iso()),
            started_at: Some(now_iso()),
            completed_at: Some(now_iso()),
            predict_time: Some(started.elapsed().as_secs_f64()),
            total_time: Some(started.elapsed().as_secs_f64()),
            saved_at: 0,
            updated_at: 0,
            run_dir: run_dir.to_string_lossy().to_string(),
            prediction: None,
        };
        let saved = history::upsert_record(record)?;
        emit_run(
            &app,
            RunProgressEvent {
                prediction_id: Some(job_id.clone()),
                owner: "blue".into(),
                name: method.clone(),
                status: "succeeded".into(),
                message: None,
                error: None,
                local_paths: vec![local.clone()],
                done: true,
            },
        );
        return Ok(RunResult {
            prediction_id: job_id,
            owner: "blue".into(),
            name: method,
            status: "succeeded".into(),
            output_urls: vec![],
            local_paths: vec![local],
            output_preview: None,
            run_dir: saved.run_dir,
            error: None,
            predict_time: saved.predict_time,
        });
    }

    let create_json = create_resp.json()?;
    let job_id = create_json
        .get("job_id")
        .and_then(|j| j.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Blue create response missing job_id: {create_json}"))?
        .to_string();

    let run_dir = history::ensure_run_dir(&job_id)?;
    let model = args
        .get("model")
        .and_then(|m| m.as_str())
        .map(str::to_string);
    let _ = history::upsert_record(JobRecord {
        job_id: job_id.clone(),
        owner: "blue".into(),
        name: method.clone(),
        version: model.clone(),
        status: "starting".into(),
        input: args.clone(),
        output_urls: vec![],
        local_paths: vec![],
        output_preview: None,
        error: None,
        created_at: Some(now_iso()),
        started_at: Some(now_iso()),
        completed_at: None,
        predict_time: None,
        total_time: None,
        saved_at: 0,
        updated_at: 0,
        run_dir: run_dir.to_string_lossy().to_string(),
        prediction: Some(create_json.clone()),
    })?;

    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(job_id.clone()),
            owner: "blue".into(),
            name: method.clone(),
            status: "processing".into(),
            message: Some(format!("Job {job_id} queued")),
            error: None,
            local_paths: vec![],
            done: false,
        },
    );

    let poll_result = poll_until_done(&creds, &method, &job_id, &app, my_gen, started).await;
    match poll_result {
        Ok((status, urls, local_paths, preview)) => {
            let elapsed = started.elapsed().as_secs_f64();
            let saved = history::upsert_record(JobRecord {
                job_id: job_id.clone(),
                owner: "blue".into(),
                name: method.clone(),
                version: model,
                status: status.clone(),
                input: args,
                output_urls: urls.clone(),
                local_paths: local_paths.clone(),
                output_preview: preview.clone(),
                error: None,
                created_at: Some(now_iso()),
                started_at: Some(now_iso()),
                completed_at: Some(now_iso()),
                predict_time: Some(elapsed),
                total_time: Some(elapsed),
                saved_at: 0,
                updated_at: 0,
                run_dir: run_dir.to_string_lossy().to_string(),
                prediction: None,
            })?;
            emit_run(
                &app,
                RunProgressEvent {
                    prediction_id: Some(job_id.clone()),
                    owner: "blue".into(),
                    name: method.clone(),
                    status: status.clone(),
                    message: None,
                    error: None,
                    local_paths: local_paths.clone(),
                    done: true,
                },
            );
            Ok(RunResult {
                prediction_id: job_id,
                owner: "blue".into(),
                name: method,
                status,
                output_urls: urls,
                local_paths,
                output_preview: preview,
                run_dir: saved.run_dir,
                error: None,
                predict_time: saved.predict_time,
            })
        }
        Err(err) => {
            let status = if err == "Cancelled" {
                "canceled"
            } else {
                "failed"
            };
            let _ = history::upsert_record(JobRecord {
                job_id: job_id.clone(),
                owner: "blue".into(),
                name: method.clone(),
                version: model,
                status: status.into(),
                input: args,
                output_urls: vec![],
                local_paths: vec![],
                output_preview: None,
                error: Some(err.clone()),
                created_at: Some(now_iso()),
                started_at: Some(now_iso()),
                completed_at: Some(now_iso()),
                predict_time: None,
                total_time: Some(started.elapsed().as_secs_f64()),
                saved_at: 0,
                updated_at: 0,
                run_dir: run_dir.to_string_lossy().to_string(),
                prediction: None,
            });
            emit_run(
                &app,
                RunProgressEvent {
                    prediction_id: Some(job_id.clone()),
                    owner: "blue".into(),
                    name: method.clone(),
                    status: status.into(),
                    message: None,
                    error: Some(err.clone()),
                    local_paths: vec![],
                    done: true,
                },
            );
            Err(err)
        }
    }
}

pub async fn wait_job(app: AppHandle, job_id: String) -> Result<RunResult, String> {
    let my_gen = cancel_ticket();
    let creds = credentials::require_credentials()?;
    let detail = history::get_job(&job_id)?
        .ok_or_else(|| format!("No local Blue job record for {job_id}"))?;
    let method = detail.record.name.clone();
    let started = Instant::now();
    let (status, urls, local_paths, preview) =
        poll_until_done(&creds, &method, &job_id, &app, my_gen, started).await?;
    let elapsed = started.elapsed().as_secs_f64();
    let mut record = detail.record;
    record.status = status.clone();
    record.output_urls = urls.clone();
    record.local_paths = local_paths.clone();
    record.output_preview = preview.clone();
    record.error = None;
    record.completed_at = Some(now_iso());
    record.predict_time = Some(elapsed);
    record.total_time = Some(elapsed);
    let saved = history::upsert_record(record)?;
    emit_run(
        &app,
        RunProgressEvent {
            prediction_id: Some(job_id.clone()),
            owner: "blue".into(),
            name: method.clone(),
            status: status.clone(),
            message: None,
            error: None,
            local_paths: local_paths.clone(),
            done: true,
        },
    );
    Ok(RunResult {
        prediction_id: job_id,
        owner: "blue".into(),
        name: method,
        status,
        output_urls: urls,
        local_paths,
        output_preview: preview,
        run_dir: saved.run_dir,
        error: None,
        predict_time: saved.predict_time,
    })
}

pub async fn redownload_job(app: AppHandle, job_id: String) -> Result<RunResult, String> {
    // Same as wait — Blue poll returns artifact again when still retained.
    wait_job(app, job_id).await
}
