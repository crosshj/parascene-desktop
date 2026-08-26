use crate::replicate::cache::{self, CrawlCheckpoint, CrawlStatus, ModelDetailDto};
use crate::replicate::client;
use crate::replicate::token;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

static PAUSE: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);
static JOB_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn job_lock() -> &'static Mutex<()> {
    JOB_LOCK.get_or_init(|| Mutex::new(()))
}

pub fn is_crawl_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn request_pause() {
    PAUSE.store(true, Ordering::SeqCst);
}

pub fn request_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
    PAUSE.store(true, Ordering::SeqCst);
}

fn clear_control_flags() {
    PAUSE.store(false, Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: String,
    pub page: u64,
    pub fetched: u64,
    pub merged: u64,
    pub status: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub done: bool,
}

fn emit_progress(app: &AppHandle, ev: ProgressEvent) {
    let _ = app.emit("replicate-models-progress", &ev);
}

async fn wait_if_paused(app: &AppHandle, cp: &mut CrawlCheckpoint) -> Result<bool, String> {
    // Returns Ok(true) if should stop (pause or cancel), Ok(false) to continue.
    if CANCEL.load(Ordering::SeqCst) {
        cp.status = CrawlStatus::Idle;
        cp.resumable = false;
        cp.next_url = None;
        cp.phase = "cancelled".into();
        cp.updated_at = Some(cache::now_millis());
        let dir = cache::replicate_dir()?;
        cache::save_checkpoint(&dir, cp)?;
        emit_progress(
            app,
            ProgressEvent {
                phase: "crawl".into(),
                page: cp.pages_done,
                fetched: cp.models_merged,
                merged: cp.models_merged,
                status: "cancelled".into(),
                message: Some("Crawl cancelled.".into()),
                error: None,
                done: true,
            },
        );
        return Ok(true);
    }
    if !PAUSE.load(Ordering::SeqCst) {
        return Ok(false);
    }
    cp.status = CrawlStatus::Paused;
    cp.resumable = cp.next_url.is_some();
    cp.phase = "paused".into();
    cp.updated_at = Some(cache::now_millis());
    let dir = cache::replicate_dir()?;
    cache::save_checkpoint(&dir, cp)?;
    emit_progress(
        app,
        ProgressEvent {
            phase: "crawl".into(),
            page: cp.pages_done,
            fetched: cp.models_merged,
            merged: cp.models_merged,
            status: "paused".into(),
            message: Some("Crawl paused.".into()),
            error: None,
            done: true,
        },
    );
    Ok(true)
}

pub async fn run_full_crawl(app: AppHandle, resume: bool) -> Result<(), String> {
    let _guard = job_lock()
        .try_lock()
        .map_err(|_| "A Replicate catalog job is already running.".to_string())?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A Replicate catalog job is already running.".into());
    }
    clear_control_flags();
    let result = run_full_crawl_inner(&app, resume).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn run_full_crawl_inner(app: &AppHandle, resume: bool) -> Result<(), String> {
    let token = token::require_token()?;
    let dir = cache::replicate_dir()?;
    let mut cp = if resume {
        let mut existing = cache::load_checkpoint(&dir);
        if existing.next_url.is_none() {
            cache::reset_checkpoint_for_full_crawl(&dir)?
        } else {
            existing.status = CrawlStatus::Running;
            existing.phase = "crawl".into();
            existing.resumable = true;
            existing.updated_at = Some(cache::now_millis());
            existing.last_error = None;
            cache::save_checkpoint(&dir, &existing)?;
            existing
        }
    } else {
        cache::reset_checkpoint_for_full_crawl(&dir)?
    };

    emit_progress(
        app,
        ProgressEvent {
            phase: "crawl".into(),
            page: cp.pages_done,
            fetched: cp.models_merged,
            merged: cp.models_merged,
            status: "running".into(),
            message: Some(if resume {
                "Resuming catalog crawl…".into()
            } else {
                "Starting catalog crawl…".into()
            }),
            error: None,
            done: false,
        },
    );

    loop {
        if wait_if_paused(app, &mut cp).await? {
            return Ok(());
        }
        let Some(url) = cp.next_url.clone() else {
            break;
        };

        let page_json = match client::get_json(&token, &url).await {
            Ok(v) => v,
            Err(e) => {
                cp.status = CrawlStatus::Paused;
                cp.resumable = true;
                cp.last_error = Some(e.clone());
                cp.updated_at = Some(cache::now_millis());
                cache::save_checkpoint(&dir, &cp)?;
                emit_progress(
                    app,
                    ProgressEvent {
                        phase: "crawl".into(),
                        page: cp.pages_done,
                        fetched: cp.models_merged,
                        merged: cp.models_merged,
                        status: "paused".into(),
                        message: Some("Crawl paused after error.".into()),
                        error: Some(e.clone()),
                        done: true,
                    },
                );
                return Err(e);
            }
        };

        let results: Vec<Value> = page_json
            .get("results")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let (total, _) = cache::merge_models_into_index(&dir, &results)?;
        cp.pages_done += 1;
        cp.models_merged = total;
        cp.next_url = page_json
            .get("next")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        cp.updated_at = Some(cache::now_millis());
        cp.last_error = None;
        cache::save_checkpoint(&dir, &cp)?;

        emit_progress(
            app,
            ProgressEvent {
                phase: "crawl".into(),
                page: cp.pages_done,
                fetched: results.len() as u64,
                merged: cp.models_merged,
                status: "running".into(),
                message: Some(format!(
                    "Page {} · {} models in catalog",
                    cp.pages_done, cp.models_merged
                )),
                error: None,
                done: false,
            },
        );

        if cp.next_url.is_none() {
            break;
        }
    }

    cp.status = CrawlStatus::Idle;
    cp.phase = "complete".into();
    cp.resumable = false;
    cp.next_url = None;
    cp.updated_at = Some(cache::now_millis());
    cache::save_checkpoint(&dir, &cp)?;

    let mut meta = cache::load_meta(&dir);
    meta.last_full_sync_at = Some(cache::now_millis());
    meta.last_error = None;
    cache::save_meta(&dir, &meta)?;

    emit_progress(
        app,
        ProgressEvent {
            phase: "crawl".into(),
            page: cp.pages_done,
            fetched: cp.models_merged,
            merged: cp.models_merged,
            status: "complete".into(),
            message: Some(format!(
                "Catalog crawl complete · {} models",
                cp.models_merged
            )),
            error: None,
            done: true,
        },
    );
    Ok(())
}

pub async fn run_check_new(app: AppHandle) -> Result<u64, String> {
    let _guard = job_lock()
        .try_lock()
        .map_err(|_| "A Replicate catalog job is already running.".to_string())?;
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A Replicate catalog job is already running.".into());
    }
    clear_control_flags();
    let result = run_check_new_inner(&app).await;
    RUNNING.store(false, Ordering::SeqCst);
    result
}

async fn run_check_new_inner(app: &AppHandle) -> Result<u64, String> {
    let token = token::require_token()?;
    let dir = cache::replicate_dir()?;
    let meta = cache::load_meta(&dir);
    let watermark = meta.newest_seen_version_at.clone();
    let map_before = cache::load_index_map(&dir)?;
    let known_ids: std::collections::HashSet<String> = map_before
        .values()
        .filter_map(|r| r.latest_version_id.clone())
        .collect();

    let mut url = Some(
        "https://api.replicate.com/v1/models?sort_by=latest_version_created_at&sort_direction=desc"
            .to_string(),
    );
    let mut pages = 0u64;
    let mut added_or_changed = 0u64;

    emit_progress(
        app,
        ProgressEvent {
            phase: "incremental".into(),
            page: 0,
            fetched: 0,
            merged: map_before.len() as u64,
            status: "running".into(),
            message: Some("Checking for new models…".into()),
            error: None,
            done: false,
        },
    );

    while let Some(u) = url {
        if CANCEL.load(Ordering::SeqCst) {
            break;
        }
        pages += 1;
        let page_json = client::get_json(&token, &u).await?;
        let results: Vec<Value> = page_json
            .get("results")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut hit_watermark = false;
        let mut page_new = 0u64;
        for m in &results {
            let id = m
                .pointer("/latest_version/id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let created = m
                .pointer("/latest_version/created_at")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !id.is_empty() && known_ids.contains(id) {
                hit_watermark = true;
            }
            if let Some(ref wm) = watermark {
                if !created.is_empty() && created <= wm.as_str() && known_ids.contains(id) {
                    hit_watermark = true;
                }
            }
            let owner = m.get("owner").and_then(|v| v.as_str()).unwrap_or("");
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let key = format!("{owner}/{name}");
            if !map_before.contains_key(&key) {
                page_new += 1;
            }
        }

        let (total, _) = cache::merge_models_into_index(&dir, &results)?;
        added_or_changed += page_new;

        emit_progress(
            app,
            ProgressEvent {
                phase: "incremental".into(),
                page: pages,
                fetched: results.len() as u64,
                merged: total,
                status: "running".into(),
                message: Some(format!("Checked page {pages} · catalog {total}")),
                error: None,
                done: false,
            },
        );

        if hit_watermark || results.is_empty() {
            break;
        }
        // Safety: don't walk forever on first incremental with empty watermark.
        if watermark.is_none() && pages >= 5 {
            break;
        }

        url = page_json
            .get("next")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
    }

    let mut meta = cache::load_meta(&dir);
    meta.last_incremental_at = Some(cache::now_millis());
    cache::save_meta(&dir, &meta)?;

    emit_progress(
        app,
        ProgressEvent {
            phase: "incremental".into(),
            page: pages,
            fetched: added_or_changed,
            merged: meta.model_count,
            status: "complete".into(),
            message: Some(format!(
                "Check complete · ~{added_or_changed} new on scanned pages"
            )),
            error: None,
            done: true,
        },
    );
    Ok(added_or_changed)
}

pub async fn update_model(
    app: AppHandle,
    owner: String,
    name: String,
) -> Result<ModelDetailDto, String> {
    let token = token::require_token()?;
    emit_progress(
        &app,
        ProgressEvent {
            phase: "detail".into(),
            page: 0,
            fetched: 0,
            merged: 0,
            status: "running".into(),
            message: Some(format!("Updating {owner}/{name}…")),
            error: None,
            done: false,
        },
    );
    let url = format!("https://api.replicate.com/v1/models/{owner}/{name}");
    let raw = client::get_json(&token, &url).await?;
    let dto = cache::save_model_detail(&owner, &name, &raw)?;
    emit_progress(
        &app,
        ProgressEvent {
            phase: "detail".into(),
            page: 0,
            fetched: 1,
            merged: 1,
            status: "complete".into(),
            message: Some(format!("Updated {owner}/{name}")),
            error: None,
            done: true,
        },
    );
    Ok(dto)
}
