//! Local history of Lab Replicate predictions under Cache/replicate/runs/.

use crate::replicate::cache;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn runs_dir() -> Result<PathBuf, String> {
    let dir = cache::replicate_dir()?.join("runs");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create runs dir: {e}"))?;
    Ok(dir)
}

fn run_dir(prediction_id: &str) -> Result<PathBuf, String> {
    Ok(runs_dir()?.join(prediction_id))
}

fn meta_path(prediction_id: &str) -> Result<PathBuf, String> {
    Ok(run_dir(prediction_id)?.join("prediction.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionRecord {
    pub prediction_id: String,
    pub owner: String,
    pub name: String,
    pub version: Option<String>,
    pub status: String,
    pub input: Value,
    #[serde(default)]
    pub output_urls: Vec<String>,
    #[serde(default)]
    pub local_paths: Vec<String>,
    /// Text / JSON string when output is not (only) downloadable files.
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
    /// Full Replicate prediction JSON when available.
    #[serde(default)]
    pub prediction: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionListRow {
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
    /// First local audio output path, for inline list preview.
    pub audio_path: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionDetail {
    pub record: PredictionRecord,
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

/// Lean on-disk shape for list view — skips `prediction` / `input` blobs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRecordFile {
    #[serde(default)]
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
    saved_at: Option<u64>,
    #[serde(default)]
    updated_at: Option<u64>,
    #[serde(default)]
    local_paths: Vec<String>,
}

fn read_list_row(meta_path: &Path) -> Result<Option<PredictionListRow>, String> {
    if !meta_path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(meta_path).map_err(|e| e.to_string())?;
    let meta: ListRecordFile = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let prediction_id = meta.prediction_id.or_else(|| {
        meta_path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    });
    let Some(prediction_id) = prediction_id.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };

    let owner = meta.owner.unwrap_or_default();
    let name = meta.name.unwrap_or_default();
    let status = meta.status.unwrap_or_else(|| "unknown".into());
    let saved_at = meta.saved_at.unwrap_or(0);
    let updated_at = meta.updated_at.unwrap_or(saved_at);

    let thumb_path = meta
        .local_paths
        .iter()
        .find(|p| is_image_path(p))
        .cloned();
    let audio_path = meta
        .local_paths
        .iter()
        .find(|p| is_audio_path(p))
        .cloned();

    Ok(Some(PredictionListRow {
        prediction_id,
        owner,
        name,
        version: meta.version.map(|v| {
            if v.len() > 12 {
                format!("{}…", &v[..7])
            } else {
                v
            }
        }),
        status,
        error: meta.error,
        created_at: meta.created_at,
        predict_time: meta.predict_time,
        total_time: meta.total_time,
        has_local_outputs: !meta.local_paths.is_empty(),
        thumb_path,
        audio_path,
        updated_at,
    }))
}

fn read_record(path: &Path) -> Result<Option<PredictionRecord>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(record_from_json(&v, path)?))
}

fn record_from_json(v: &Value, meta_file: &Path) -> Result<PredictionRecord, String> {
    let prediction_id = v
        .get("predictionId")
        .or_else(|| v.pointer("/prediction/id"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| "prediction.json missing predictionId".to_string())?
        .to_string();

    let owner = v
        .get("owner")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let prediction = v.get("prediction").cloned();
    let mut status = v
        .get("status")
        .and_then(|x| x.as_str())
        .or_else(|| prediction.as_ref().and_then(|p| p.get("status")).and_then(|x| x.as_str()))
        .unwrap_or("unknown")
        .to_string();
    if status == "unknown" {
        // Legacy meta written only after download.
        status = "succeeded".into();
    }

    let input = v
        .get("input")
        .cloned()
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.get("input").cloned())
        })
        .unwrap_or(json!({}));

    let output_urls = v
        .get("outputUrls")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|u| u.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let local_paths = v
        .get("localPaths")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|u| u.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_else(|| {
            // Discover out_* files next to meta.
            let dir = meta_file.parent();
            let mut found = Vec::new();
            if let Some(dir) = dir {
                if let Ok(rd) = std::fs::read_dir(dir) {
                    for entry in rd.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.starts_with("out_") {
                            found.push(entry.path().to_string_lossy().to_string());
                        }
                    }
                }
            }
            found.sort();
            found
        });

    let error = v
        .get("error")
        .and_then(|x| {
            if x.is_null() {
                None
            } else {
                x.as_str().map(|s| s.to_string()).or(Some(x.to_string()))
            }
        })
        .or_else(|| {
            prediction.as_ref().and_then(|p| {
                p.get("error").and_then(|x| {
                    if x.is_null() {
                        None
                    } else {
                        x.as_str().map(|s| s.to_string()).or(Some(x.to_string()))
                    }
                })
            })
        });

    let created_at = v
        .get("createdAt")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.get("created_at"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });
    let started_at = v
        .get("startedAt")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.get("started_at"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });
    let completed_at = v
        .get("completedAt")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.get("completed_at"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });

    let predict_time = v
        .get("predictTime")
        .and_then(|x| x.as_f64())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.pointer("/metrics/predict_time"))
                .and_then(|x| x.as_f64())
        });
    let total_time = v
        .get("totalTime")
        .and_then(|x| x.as_f64())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.pointer("/metrics/total_time"))
                .and_then(|x| x.as_f64())
        });

    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            prediction
                .as_ref()
                .and_then(|p| p.get("version"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
        });

    let saved_at = v
        .get("savedAt")
        .and_then(|x| x.as_u64())
        .unwrap_or(0);
    let updated_at = v
        .get("updatedAt")
        .and_then(|x| x.as_u64())
        .unwrap_or(saved_at);

    let run_dir_str = meta_file
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut output_preview = v
        .get("outputPreview")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    if output_preview.is_none() {
        if let Some(out) = prediction.as_ref().and_then(|p| p.get("output")) {
            output_preview = preview_from_output(out);
        }
    }
    // Recover from failed-but-actually-text runs that stored a misleading error.
    let mut status = status;
    let mut error = error;
    if status == "failed"
        && error
            .as_deref()
            .is_some_and(|e| e.contains("no downloadable URLs"))
        && output_preview.is_some()
    {
        status = "succeeded".into();
        error = None;
    }

    Ok(PredictionRecord {
        prediction_id,
        owner,
        name,
        version,
        status,
        input,
        output_urls,
        local_paths,
        output_preview,
        error,
        created_at,
        started_at,
        completed_at,
        predict_time,
        total_time,
        saved_at,
        updated_at,
        run_dir: run_dir_str,
        prediction,
    })
}

fn preview_from_output(output: &Value) -> Option<String> {
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

pub fn upsert_record(mut record: PredictionRecord) -> Result<PredictionRecord, String> {
    let now = cache::now_millis();
    if record.saved_at == 0 {
        record.saved_at = now;
    }
    record.updated_at = now;
    let dir = run_dir(&record.prediction_id)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create run dir: {e}"))?;
    record.run_dir = dir.to_string_lossy().to_string();
    let path = dir.join("prediction.json");
    let pretty = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    let tmp = dir.join(".prediction.json.tmp");
    std::fs::write(&tmp, &pretty).map_err(|e| format!("Write failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Rename failed: {e}"))?;
    Ok(record)
}

/// Create or refresh a record from a live Replicate prediction payload.
pub fn upsert_from_prediction(
    owner: &str,
    name: &str,
    version: &str,
    input: &Value,
    prediction: &Value,
    status_override: Option<&str>,
    output_urls: &[String],
    local_paths: &[String],
    error: Option<&str>,
) -> Result<PredictionRecord, String> {
    upsert_from_prediction_with_preview(
        owner,
        name,
        version,
        input,
        prediction,
        status_override,
        output_urls,
        local_paths,
        None,
        error,
    )
}

pub fn upsert_from_prediction_with_preview(
    owner: &str,
    name: &str,
    version: &str,
    input: &Value,
    prediction: &Value,
    status_override: Option<&str>,
    output_urls: &[String],
    local_paths: &[String],
    output_preview: Option<&str>,
    error: Option<&str>,
) -> Result<PredictionRecord, String> {
    let prediction_id = prediction
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Prediction missing id".to_string())?
        .to_string();

    let existing = read_record(&meta_path(&prediction_id)?)?;
    let saved_at = existing.as_ref().map(|r| r.saved_at).unwrap_or(0);

    let status = status_override
        .map(|s| s.to_string())
        .or_else(|| {
            prediction
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".into());

    let preview = output_preview.map(|s| s.to_string()).or_else(|| {
        prediction
            .get("output")
            .and_then(preview_from_output)
    });

    let record = PredictionRecord {
        prediction_id,
        owner: owner.to_string(),
        name: name.to_string(),
        version: Some(version.to_string()),
        status,
        input: input.clone(),
        output_urls: output_urls.to_vec(),
        local_paths: local_paths.to_vec(),
        output_preview: preview,
        error: error.map(|s| s.to_string()).or_else(|| {
            prediction.get("error").and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str().map(|s| s.to_string()).or(Some(x.to_string()))
                }
            })
        }),
        created_at: prediction
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        started_at: prediction
            .get("started_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        completed_at: prediction
            .get("completed_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        predict_time: prediction
            .pointer("/metrics/predict_time")
            .and_then(|v| v.as_f64()),
        total_time: prediction
            .pointer("/metrics/total_time")
            .and_then(|v| v.as_f64()),
        saved_at,
        updated_at: 0,
        run_dir: String::new(),
        prediction: Some(prediction.clone()),
    };
    upsert_record(record)
}

pub fn list_predictions(
    status_filter: Option<String>,
    model_query: Option<String>,
) -> Result<Vec<PredictionListRow>, String> {
    let dir = runs_dir()?;
    let mut rows: Vec<PredictionListRow> = Vec::new();
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Ok(rows),
    };

    let status_filter = status_filter
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s != "all");
    let model_query = model_query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta = path.join("prediction.json");
        let Some(row) = read_list_row(&meta)? else {
            continue;
        };

        if let Some(ref st) = status_filter {
            if row.status.to_lowercase() != *st {
                continue;
            }
        }
        if let Some(ref q) = model_query {
            let key = format!("{}/{}", row.owner, row.name).to_lowercase();
            let id = row.prediction_id.to_lowercase();
            if !key.contains(q.as_str()) && !id.contains(q.as_str()) {
                continue;
            }
        }

        rows.push(row);
    }

    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(rows)
}

pub fn get_prediction(prediction_id: &str) -> Result<Option<PredictionDetail>, String> {
    let path = meta_path(prediction_id)?;
    Ok(read_record(&path)?.map(|record| PredictionDetail { record }))
}
