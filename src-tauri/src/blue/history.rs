//! Local history of Lab Blue jobs under Cache/blue/runs/.

use crate::library::paths::{account_root, ensure_directories, resolve_paths};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn blue_dir() -> Result<PathBuf, String> {
    let root = account_root()?;
    let paths = resolve_paths(root);
    ensure_directories(&paths)?;
    let dir = paths.cache.join("blue");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

pub fn runs_dir() -> Result<PathBuf, String> {
    let dir = blue_dir()?.join("runs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create runs dir: {e}"))?;
    Ok(dir)
}

fn run_dir(job_id: &str) -> Result<PathBuf, String> {
    Ok(runs_dir()?.join(job_id))
}

fn meta_path(job_id: &str) -> Result<PathBuf, String> {
    Ok(run_dir(job_id)?.join("job.json"))
}

fn list_sidecar_path(job_id: &str) -> Result<PathBuf, String> {
    Ok(run_dir(job_id)?.join("list.json"))
}

fn sanitize_run_id(id: &str) -> Result<String, String> {
    let t = id.trim();
    if t.is_empty() {
        return Err("Job id is empty.".into());
    }
    if t.contains('/') || t.contains('\\') || t.contains("..") {
        return Err("Invalid job id.".into());
    }
    Ok(t.to_string())
}

/// Delete local Lab Blue job history (run folder + cached outputs).
pub fn delete_job(job_id: &str) -> Result<(), String> {
    let id = sanitize_run_id(job_id)?;
    let dir = run_dir(&id)?;
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|e| format!("Could not delete Blue job {}: {e}", dir.display()))?;
    Ok(())
}

const HEAVY_INPUT_CHARS: usize = 2_048;

fn is_heavy_string(s: &str) -> bool {
    s.len() > HEAVY_INPUT_CHARS || s.starts_with("data:")
}

pub fn redact_heavy_json(value: &Value) -> Value {
    match value {
        Value::String(s) if is_heavy_string(s) => {
            let kind = if s.starts_with("data:") {
                "data-uri"
            } else {
                "string"
            };
            json!(format!("[{kind}: {chars} chars]", chars = s.len()))
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_heavy_json).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                out.insert(k.clone(), redact_heavy_json(v));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    /// Same wire key as Replicate Lab predictions (`predictionId`).
    #[serde(rename = "predictionId", alias = "jobId")]
    pub job_id: String,
    /// Always "blue" for Lab catalog identity.
    pub owner: String,
    /// Method id (e.g. image2video).
    pub name: String,
    pub version: Option<String>,
    pub status: String,
    pub input: Value,
    #[serde(default)]
    pub output_urls: Vec<String>,
    #[serde(default)]
    pub local_paths: Vec<String>,
    #[serde(default)]
    pub output_preview: Option<String>,
    pub error: Option<String>,
    pub created_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub predict_time: Option<f64>,
    pub total_time: Option<f64>,
    pub saved_at: u64,
    pub updated_at: u64,
    pub run_dir: String,
    #[serde(default)]
    pub prediction: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListRow {
    pub prediction_id: String,
    pub owner: String,
    pub name: String,
    pub version: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub created_at: Option<String>,
    pub predict_time: Option<f64>,
    pub total_time: Option<f64>,
    pub has_local_outputs: bool,
    pub thumb_path: Option<String>,
    pub audio_path: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    pub record: JobRecord,
}

fn is_image_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
}

fn is_audio_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".mp3")
        || lower.ends_with(".wav")
        || lower.ends_with(".m4a")
        || lower.ends_with(".aac")
        || lower.ends_with(".ogg")
        || lower.ends_with(".oga")
        || lower.ends_with(".flac")
        || lower.ends_with(".opus")
}

fn is_video_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".mp4")
        || lower.ends_with(".mov")
        || lower.ends_with(".webm")
        || lower.ends_with(".m4v")
        || lower.ends_with(".mkv")
        || lower.ends_with(".avi")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRecordFile {
    #[serde(default)]
    #[allow(dead_code)]
    job_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    prediction_id: Option<String>,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    predict_time: Option<f64>,
    #[serde(default)]
    total_time: Option<f64>,
    #[serde(default)]
    local_paths: Vec<String>,
    #[serde(default)]
    updated_at: Option<u64>,
}

fn write_list_sidecar(record: &JobRecord) -> Result<(), String> {
    let path = list_sidecar_path(&record.job_id)?;
    let lean = json!({
        "jobId": record.job_id,
        "predictionId": record.job_id,
        "owner": record.owner,
        "name": record.name,
        "version": record.version,
        "status": record.status,
        "error": record.error,
        "createdAt": record.created_at,
        "predictTime": record.predict_time,
        "totalTime": record.total_time,
        "localPaths": record.local_paths,
        "updatedAt": record.updated_at,
    });
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&lean).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Write list sidecar: {e}"))
}

fn write_detail(record: &JobRecord) -> Result<(), String> {
    let dir = run_dir(&record.job_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir run: {e}"))?;
    let path = meta_path(&record.job_id)?;
    let mut lean = record.clone();
    lean.input = redact_heavy_json(&lean.input);
    if let Some(p) = lean.prediction.as_ref() {
        lean.prediction = Some(redact_heavy_json(p));
    }
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&lean).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Write job meta: {e}"))?;
    write_list_sidecar(record)?;
    Ok(())
}

fn read_record(job_id: &str) -> Result<Option<JobRecord>, String> {
    let path = meta_path(job_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Read job: {e}"))?;
    let mut record: JobRecord =
        serde_json::from_str(&raw).map_err(|e| format!("Parse job: {e}"))?;
    if record.job_id.is_empty() {
        record.job_id = job_id.to_string();
    }
    Ok(Some(record))
}

pub fn upsert_record(mut record: JobRecord) -> Result<JobRecord, String> {
    let now = now_ms();
    if record.saved_at == 0 {
        record.saved_at = now;
    }
    record.updated_at = now;
    if record.run_dir.is_empty() {
        record.run_dir = run_dir(&record.job_id)?.to_string_lossy().to_string();
    }
    if record.owner.is_empty() {
        record.owner = "blue".into();
    }
    write_detail(&record)?;
    Ok(record)
}

pub fn get_job(job_id: &str) -> Result<Option<JobDetail>, String> {
    Ok(read_record(job_id)?.map(|record| JobDetail { record }))
}

pub fn list_jobs(status: Option<String>, query: Option<String>) -> Result<Vec<JobListRow>, String> {
    let dir = runs_dir()?;
    let status_filter = status
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s != "all");
    let q = query
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let mut rows = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Read runs: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let job_id = match path.file_name().and_then(|s| s.to_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let list_path = path.join("list.json");
        let (
            owner,
            name,
            version,
            st,
            error,
            created_at,
            predict_time,
            total_time,
            local_paths,
            updated_at,
        ) = if list_path.exists() {
            let raw = std::fs::read_to_string(&list_path).unwrap_or_default();
            match serde_json::from_str::<ListRecordFile>(&raw) {
                Ok(f) => (
                    f.owner.unwrap_or_else(|| "blue".into()),
                    f.name.unwrap_or_default(),
                    f.version,
                    f.status.unwrap_or_else(|| "unknown".into()),
                    f.error,
                    f.created_at,
                    f.predict_time,
                    f.total_time,
                    f.local_paths,
                    f.updated_at.unwrap_or(0),
                ),
                Err(_) => continue,
            }
        } else if let Ok(Some(rec)) = read_record(&job_id) {
            let _ = write_list_sidecar(&rec);
            (
                rec.owner,
                rec.name,
                rec.version,
                rec.status,
                rec.error,
                rec.created_at,
                rec.predict_time,
                rec.total_time,
                rec.local_paths,
                rec.updated_at,
            )
        } else {
            continue;
        };

        if let Some(ref sf) = status_filter {
            if st.to_lowercase() != *sf {
                continue;
            }
        }
        if let Some(ref qq) = q {
            let blob = format!("{owner}/{name} {job_id} {st}").to_lowercase();
            if !blob.contains(qq) {
                continue;
            }
        }

        let thumb_path = local_paths
            .iter()
            .find(|p| is_image_path(p) || is_video_path(p))
            .cloned();
        let audio_path = local_paths.iter().find(|p| is_audio_path(p)).cloned();
        rows.push(JobListRow {
            prediction_id: job_id,
            owner,
            name,
            version,
            status: st,
            error,
            created_at,
            predict_time,
            total_time,
            has_local_outputs: !local_paths.is_empty(),
            thumb_path,
            audio_path,
            updated_at,
        });
    }
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

pub fn ensure_run_dir(job_id: &str) -> Result<PathBuf, String> {
    let dir = run_dir(job_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir: {e}"))?;
    Ok(dir)
}
