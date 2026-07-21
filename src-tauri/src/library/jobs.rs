//! Durable generation / Parascene work queue.
//!
//! Generic job kinds (`create_media`, `wait_creation`, `group_creations`,
//! `delete_creation`, `ensure_project_groups`, `cleanup_project_groups`).
//! Lab and other surfaces enqueue work and render status — they do not own
//! the create/wait/group coordination loop.

use super::catalog::{
    default_paths, delete_creation_local, get_creation_by_id, ingest_remote_creation_json,
    ready_connection,
};
use super::download::{emit_creation_updated, enqueue_media, enqueue_thumbs};
use super::parascene_api::{
    cover_source_id, create_media, creation_id, creation_status, delete_creation, get_creation,
    group_creations, group_member_ids, media_url, CreateOpts,
};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const WAIT_POLL_MS: u64 = 2_000;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub project_id: Option<String>,
    pub label: Option<String>,
    pub payload_json: String,
    pub result_json: Option<String>,
    pub checkpoint_json: Option<String>,
    pub progress_note: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueJobRequest {
    pub kind: String,
    pub project_id: Option<String>,
    pub label: Option<String>,
    pub payload: Value,
}

struct RunnerState {
    running: bool,
}

fn runner_state() -> &'static Mutex<RunnerState> {
    static STATE: OnceLock<Mutex<RunnerState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(RunnerState { running: false }))
}

fn cancelled_ids() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn mark_cancel_request(id: &str) {
    if let Ok(mut set) = cancelled_ids().lock() {
        set.insert(id.to_string());
    }
}

fn clear_cancel_request(id: &str) {
    if let Ok(mut set) = cancelled_ids().lock() {
        set.remove(id);
    }
}

fn is_cancel_requested(id: &str) -> bool {
    cancelled_ids()
        .lock()
        .map(|set| set.contains(id))
        .unwrap_or(false)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

fn with_conn<T>(f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    f(&conn)
}

fn row_from_query(row: &rusqlite::Row<'_>) -> Result<Job, rusqlite::Error> {
    Ok(Job {
        id: row.get(0)?,
        kind: row.get(1)?,
        status: row.get(2)?,
        project_id: row.get(3)?,
        label: row.get(4)?,
        payload_json: row.get(5)?,
        result_json: row.get(6)?,
        checkpoint_json: row.get(7)?,
        progress_note: row.get(8)?,
        error: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const JOB_SELECT: &str = "SELECT id, kind, status, project_id, label, payload_json, result_json,
        checkpoint_json, progress_note, error, created_at, updated_at FROM jobs";

fn get_job_conn(conn: &Connection, id: &str) -> Result<Option<Job>, String> {
    let mut stmt = conn
        .prepare(&format!("{JOB_SELECT} WHERE id = ?1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(row_from_query(row).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

fn insert_job(conn: &Connection, job: &Job) -> Result<(), String> {
    conn.execute(
        "INSERT INTO jobs(
            id, kind, status, project_id, label, payload_json, result_json,
            checkpoint_json, progress_note, error, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            job.id,
            job.kind,
            job.status,
            job.project_id,
            job.label,
            job.payload_json,
            job.result_json,
            job.checkpoint_json,
            job.progress_note,
            job.error,
            job.created_at,
            job.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn update_job_fields(
    conn: &Connection,
    id: &str,
    status: Option<&str>,
    progress_note: Option<&str>,
    checkpoint_json: Option<&str>,
    result_json: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let updated = now_rfc3339();
    conn.execute(
        "UPDATE jobs SET
            status = COALESCE(?2, status),
            progress_note = COALESCE(?3, progress_note),
            checkpoint_json = COALESCE(?4, checkpoint_json),
            result_json = COALESCE(?5, result_json),
            error = COALESCE(?6, error),
            updated_at = ?7
         WHERE id = ?1",
        params![
            id,
            status,
            progress_note,
            checkpoint_json,
            result_json,
            error,
            updated,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_job(app: &AppHandle, job: &Job) {
    let _ = app.emit("jobs-updated", job);
}

fn load_and_emit(app: &AppHandle, id: &str) -> Result<Job, String> {
    let job = with_conn(|conn| {
        get_job_conn(conn, id)?.ok_or_else(|| format!("job {id} not found"))
    })?;
    emit_job(app, &job);
    Ok(job)
}

fn patch_job(
    app: &AppHandle,
    id: &str,
    status: Option<&str>,
    progress_note: Option<&str>,
    checkpoint: Option<&Value>,
    result: Option<&Value>,
    error: Option<&str>,
) -> Result<Job, String> {
    let checkpoint_s = checkpoint
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "{}".into()));
    let result_s = result.map(|v| serde_json::to_string(v).unwrap_or_else(|_| "{}".into()));
    with_conn(|conn| {
        update_job_fields(
            conn,
            id,
            status,
            progress_note,
            checkpoint_s.as_deref(),
            result_s.as_deref(),
            error,
        )
    })?;
    load_and_emit(app, id)
}

fn throw_if_cancelled(id: &str) -> Result<(), String> {
    if is_cancel_requested(id) {
        Err("Cancelled".into())
    } else {
        Ok(())
    }
}

async fn ingest_and_warm(app: &AppHandle, creation: &Value) {
    match ingest_remote_creation_json(creation) {
        Ok(id) => {
            // Same warm path as FE ingestRemoteCreation → downloadPending:
            // prefer fit thumb, then square, then full image; queue media too.
            enqueue_thumbs(app.clone(), vec![id.clone()], true);
            enqueue_media(app.clone(), vec![id.clone()], true);
            emit_creation_updated(app, &id);
        }
        Err(err) => {
            eprintln!("[jobs] catalog ingest failed: {err}");
        }
    }
}

async fn wait_creation_loop(
    app: &AppHandle,
    job_id: &str,
    creation_id: &str,
    timeout_ms: u64,
    on_tick: impl Fn(&Value) -> Result<(), String>,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    loop {
        throw_if_cancelled(job_id)?;
        let row = get_creation(creation_id).await?;
        on_tick(&row)?;
        let status = creation_status(&row);
        if status != "creating" && status != "pending" {
            ingest_and_warm(app, &row).await;
            return Ok(row);
        }
        if started.elapsed() > Duration::from_millis(timeout_ms) {
            return Err(format!("Timed out waiting for creation {creation_id}"));
        }
        tokio::time::sleep(Duration::from_millis(WAIT_POLL_MS)).await;
    }
}

fn payload_str(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(|v| match v {
            Value::String(s) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                }
            }
            Value::Number(n) => Some(n.to_string()),
            Value::Null => None,
            _ => None,
        })
}

fn payload_str_or_null(payload: &Value, key: &str) -> Option<Option<String>> {
    match payload.get(key) {
        None => None,
        Some(Value::Null) => Some(None),
        Some(v) => match v {
            Value::String(s) => {
                let t = s.trim();
                Some(if t.is_empty() {
                    None
                } else {
                    Some(t.to_string())
                })
            }
            Value::Number(n) => Some(Some(n.to_string())),
            _ => Some(None),
        },
    }
}

fn new_creation_token() -> String {
    Uuid::new_v4().to_string()
}

fn party_name(project_title: &str, kind: &str) -> String {
    let base = {
        let t = project_title.trim();
        if t.is_empty() {
            "Project"
        } else {
            t
        }
    };
    // Human-visible on Parascene; machine role is stamped in `meta.desktop`.
    if kind == "images" {
        format!("Parascene Desktop · {base} · Images")
    } else {
        format!("Parascene Desktop · {base} · Videos")
    }
}

fn desktop_cabinet_meta(project_id: Option<&str>, kind: &str) -> Value {
    let role = if kind == "images" {
        "project_images"
    } else {
        "project_videos"
    };
    let mut desktop = json!({
        "role": role,
        "client": "parascene-desktop",
    });
    if let Some(pid) = project_id.map(str::trim).filter(|s| !s.is_empty()) {
        desktop["projectId"] = json!(pid);
    }
    json!({ "desktop": desktop })
}

/// Merge party name + desktop meta + source_creation_ids onto a group JSON row.
fn stamp_group_membership_json(
    row: &Value,
    member_ids: &[String],
    project_id: Option<&str>,
    kind: &str,
    project_title: &str,
) -> Value {
    let mut out = row.clone();
    let Some(obj) = out.as_object_mut() else {
        return out;
    };
    obj.insert("title".into(), json!(party_name(project_title, kind)));
    let mut meta = obj
        .get("meta")
        .and_then(|m| m.as_object())
        .cloned()
        .unwrap_or_default();
    let desktop_blob = desktop_cabinet_meta(project_id, kind);
    if let Some(desktop) = desktop_blob.get("desktop") {
        meta.insert("desktop".into(), desktop.clone());
    }
    let mut group = meta
        .get("group")
        .and_then(|g| g.as_object())
        .cloned()
        .unwrap_or_default();
    group.insert("kind".into(), json!("group_creations"));
    let source_ids: Vec<Value> = member_ids
        .iter()
        .map(|id| {
            id.parse::<i64>()
                .map(Value::from)
                .unwrap_or_else(|_| json!(id))
        })
        .collect();
    group.insert("source_creation_ids".into(), Value::Array(source_ids));
    meta.insert("group".into(), Value::Object(group));
    obj.insert("meta".into(), Value::Object(meta));
    out
}

struct EnsureCtx {
    job_id: String,
    project_id: Option<String>,
    project_title: String,
    aspect_ratio: String,
    still_prompt: String,
    animate_prompt: String,
    images_group_id: Option<String>,
    videos_group_id: Option<String>,
    pending_creation_id: Option<String>,
    project_creation_ids: Vec<String>,
    messages: Vec<String>,
}

impl EnsureCtx {
    fn checkpoint(&self) -> Value {
        json!({
            "imagesGroupId": self.images_group_id,
            "videosGroupId": self.videos_group_id,
            "pendingCreationId": self.pending_creation_id,
            "projectCreationIds": self.project_creation_ids,
            "messages": self.messages,
        })
    }
}

async fn note(app: &AppHandle, ctx: &mut EnsureCtx, msg: &str) -> Result<(), String> {
    ctx.messages.push(msg.to_string());
    patch_job(
        app,
        &ctx.job_id,
        Some("running"),
        Some(msg),
        Some(&ctx.checkpoint()),
        None,
        None,
    )?;
    Ok(())
}

async fn set_pending(
    app: &AppHandle,
    ctx: &mut EnsureCtx,
    pending: Option<String>,
) -> Result<(), String> {
    ctx.pending_creation_id = pending;
    patch_job(
        app,
        &ctx.job_id,
        Some("waiting"),
        ctx.messages.last().map(|s| s.as_str()),
        Some(&ctx.checkpoint()),
        None,
        None,
    )?;
    Ok(())
}

async fn verify_live_group(
    app: &AppHandle,
    ctx: &mut EnsureCtx,
    id: Option<String>,
    label: &str,
) -> Result<Option<String>, String> {
    let Some(id) = id else {
        return Ok(None);
    };
    match get_creation(&id).await {
        Ok(row) => {
            ingest_and_warm(app, &row).await;
            note(
                app,
                ctx,
                &format!("{label}: verified {id} still on Parascene."),
            )
            .await?;
            Ok(creation_id(&row))
        }
        Err(_) => {
            note(
                app,
                ctx,
                &format!("{label}: stored group {id} is missing (deleted?) — starting fresh."),
            )
            .await?;
            Ok(None)
        }
    }
}

async fn group_members(
    app: &AppHandle,
    project_title: &str,
    project_id: Option<&str>,
    kind: &str,
    existing_group_id: Option<&str>,
    member_ids: &[String],
) -> Result<String, String> {
    // Append with [cover, ...new] only. Already-filed members are often hidden
    // as standalone rows — resending them returns "Cannot group deleted creations".
    let mut ids = Vec::new();
    if let Some(gid) = existing_group_id {
        ids.push(gid.to_string());
    }
    for id in member_ids {
        if !ids.iter().any(|x| x == id) {
            ids.push(id.clone());
        }
    }
    let prior_members = if let Some(gid) = existing_group_id {
        let mut existing = load_group_member_ids(gid).await;
        if existing.is_empty() {
            existing = load_local_group_member_ids(gid);
        }
        existing
    } else {
        Vec::new()
    };
    let meta = desktop_cabinet_meta(project_id, kind);
    let grouped = group_creations(
        &ids,
        Some(&party_name(project_title, kind)),
        Some(&meta),
    )
    .await?;
    let group_id = creation_id(&grouped).ok_or_else(|| "group response missing id".to_string())?;
    let full = get_creation(&group_id).await?;
    // Detail often omits meta.group — stamp expected membership for local Assets.
    let mut live = group_member_ids(&full);
    if live.is_empty() {
        let mut expected = prior_members;
        for id in member_ids {
            if !expected.iter().any(|x| x == id) {
                expected.push(id.clone());
            }
        }
        live = expected;
    }
    let stamped = stamp_group_membership_json(&full, &live, project_id, kind, project_title);
    ingest_and_warm(app, &stamped).await;
    Ok(group_id)
}

async fn create_image_seed(app: &AppHandle, ctx: &mut EnsureCtx) -> Result<String, String> {
    throw_if_cancelled(&ctx.job_id)?;
    note(
        app,
        ctx,
        &format!(
            "Generating suite still for Images group ({})…",
            ctx.aspect_ratio
        ),
    )
    .await?;
    let started = create_media(CreateOpts {
        server_id: 1,
        method: "replicate".into(),
        args: json!({
            "prompt": ctx.still_prompt,
            "model": "xai/grok-imagine-image",
            "aspect_ratio": ctx.aspect_ratio,
        }),
        creation_token: new_creation_token(),
        mutate_of_id: None,
        group_id: None,
    })
    .await?;
    let id = creation_id(&started).ok_or_else(|| "create image missing id".to_string())?;
    set_pending(app, ctx, Some(id.clone())).await?;
    note(app, ctx, &format!("Waiting for image {id}…")).await?;
    let job_id = ctx.job_id.clone();
    let done = wait_creation_loop(app, &job_id, &id, 180_000, |row| {
        // progress ticks without holding ctx mutably across await — update via patch
        let status = creation_status(row);
        let note = format!("Waiting for image {id} ({status}).");
        let _ = with_conn(|conn| {
            update_job_fields(conn, &job_id, Some("waiting"), Some(&note), None, None, None)
        });
        let _ = load_and_emit(app, &job_id);
        Ok(())
    })
    .await?;
    if creation_status(&done) == "failed" {
        return Err(format!("Image seed failed ({id})"));
    }
    set_pending(app, ctx, None).await?;
    Ok(id)
}

async fn create_video_from_still(
    app: &AppHandle,
    ctx: &mut EnsureCtx,
    image_url: &str,
) -> Result<String, String> {
    throw_if_cancelled(&ctx.job_id)?;
    let started = create_media(CreateOpts {
        server_id: 6,
        method: "image2video".into(),
        args: json!({
            "prompt": ctx.animate_prompt,
            "model": "ltx_i2v",
            "aspect_ratio": ctx.aspect_ratio,
            "input_images": [image_url],
        }),
        creation_token: new_creation_token(),
        mutate_of_id: None,
        group_id: None,
    })
    .await?;
    let id = creation_id(&started).ok_or_else(|| "create video missing id".to_string())?;
    set_pending(app, ctx, Some(id.clone())).await?;
    note(app, ctx, &format!("Waiting for video {id}…")).await?;
    let job_id = ctx.job_id.clone();
    let done = wait_creation_loop(app, &job_id, &id, 20 * 60_000, |_| Ok(())).await?;
    if creation_status(&done) == "failed" {
        return Err(format!(
            "Video seed failed ({id}). Check Parascene Blue / LTX is available."
        ));
    }
    let full = get_creation(&id).await?;
    let media_type = full
        .get("media_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let has_video = media_type == "video"
        || full.get("video_url").and_then(|v| v.as_str()).is_some()
        || media_url(&full).is_some();
    if !has_video && !media_type.is_empty() && media_type != "video" {
        return Err(format!(
            "Expected a video creation, got media_type={} id={id}",
            full.get("media_type")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
        ));
    }
    ingest_and_warm(app, &full).await;
    set_pending(app, ctx, None).await?;
    Ok(id)
}

async fn create_text_video_seed(app: &AppHandle, ctx: &mut EnsureCtx) -> Result<String, String> {
    throw_if_cancelled(&ctx.job_id)?;
    let started = create_media(CreateOpts {
        server_id: 6,
        method: "text2video".into(),
        args: json!({
            "prompt": ctx.animate_prompt,
            "model": "ltx_t2v",
            "aspect_ratio": ctx.aspect_ratio,
        }),
        creation_token: new_creation_token(),
        mutate_of_id: None,
        group_id: None,
    })
    .await?;
    let id = creation_id(&started).ok_or_else(|| "create text video missing id".to_string())?;
    set_pending(app, ctx, Some(id.clone())).await?;
    note(app, ctx, &format!("Waiting for text→video {id}…")).await?;
    let job_id = ctx.job_id.clone();
    let done = wait_creation_loop(app, &job_id, &id, 20 * 60_000, |_| Ok(())).await?;
    if creation_status(&done) == "failed" {
        return Err(format!("Text→video seed failed ({id})"));
    }
    let full = get_creation(&id).await?;
    ingest_and_warm(app, &full).await;
    set_pending(app, ctx, None).await?;
    Ok(id)
}

async fn wait_for_url(
    app: &AppHandle,
    job_id: &str,
    id: &str,
    timeout_ms: u64,
) -> Result<Option<String>, String> {
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(timeout_ms) {
        throw_if_cancelled(job_id)?;
        let row = get_creation(id).await?;
        if let Some(url) = media_url(&row) {
            return Ok(Some(url));
        }
        let note = format!("Waiting for media URL on {id}…");
        let _ = with_conn(|conn| {
            update_job_fields(conn, job_id, Some("waiting"), Some(&note), None, None, None)
        });
        let _ = load_and_emit(app, job_id);
        tokio::time::sleep(Duration::from_millis(1_500)).await;
    }
    throw_if_cancelled(job_id)?;
    let last = get_creation(id).await?;
    Ok(media_url(&last))
}

async fn resolve_still_for_video(
    app: &AppHandle,
    ctx: &mut EnsureCtx,
    primary_image_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    throw_if_cancelled(&ctx.job_id)?;
    if let Some(gid) = ctx.images_group_id.clone() {
        if let Ok(group) = get_creation(&gid).await {
            // Newest first: cover_source_id (group artwork) then members
            // newest→oldest (append order is oldest→newest).
            let mut candidates = Vec::new();
            let mut seen = HashSet::new();
            if let Some(cover_id) = cover_source_id(&group) {
                if seen.insert(cover_id.clone()) {
                    candidates.push(cover_id);
                }
            }
            let mut members = group_member_ids(&group);
            members.reverse();
            for sid in members {
                if seen.insert(sid.clone()) {
                    candidates.push(sid);
                }
            }
            for sid in candidates {
                if let Ok(row) = get_creation(&sid).await {
                    if let Some(url) = media_url(&row) {
                        note(
                            app,
                            ctx,
                            &format!("Videos: using Images group member {sid} as still."),
                        )
                        .await?;
                        return Ok((url, None));
                    }
                }
            }
            if let Some(cover) = media_url(&group) {
                note(app, ctx, "Videos: using Images group cover as still.").await?;
                return Ok((cover, None));
            }
        }
    }
    if let Some(id) = primary_image_id {
        if let Ok(row) = get_creation(id).await {
            if let Some(url) = media_url(&row) {
                note(app, ctx, &format!("Videos: using image {id} as still.")).await?;
                return Ok((url, None));
            }
        }
    }

    note(app, ctx, "Videos: no still available — generating suite still…").await?;
    let still_id = create_image_seed(app, ctx).await?;
    let job_id = ctx.job_id.clone();
    let image_url = wait_for_url(app, &job_id, &still_id, 60_000)
        .await?
        .ok_or_else(|| "Video seed still has no URL after create".to_string())?;
    Ok((image_url, Some(still_id)))
}

async fn load_group_member_ids(group_id: &str) -> Vec<String> {
    match get_creation(group_id).await {
        Ok(row) => group_member_ids(&row),
        Err(_) => Vec::new(),
    }
}

fn load_local_group_member_ids(group_id: &str) -> Vec<String> {
    let Ok(paths) = default_paths() else {
        return Vec::new();
    };
    let Ok(conn) = ready_connection(&paths) else {
        return Vec::new();
    };
    let Ok(Some(row)) = get_creation_by_id(&conn, group_id) else {
        return Vec::new();
    };
    let Some(raw) = row.remote_json.as_deref() else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => group_member_ids(&value),
        Err(_) => Vec::new(),
    }
}

/// Collect remote + local membership for a group cover (detail often omits meta.group).
async fn resolve_group_member_ids_for_cleanup(group_id: &str) -> Vec<String> {
    let mut members = load_group_member_ids(group_id).await;
    if members.is_empty() {
        members = load_local_group_member_ids(group_id);
    } else {
        for mid in load_local_group_member_ids(group_id) {
            if !members.iter().any(|x| x == &mid) {
                members.push(mid);
            }
        }
    }
    members
}

/// Best-effort local catalog + disk purge (Library). Missing rows are fine.
fn delete_local_best_effort(app: &AppHandle, id: &str) -> bool {
    let Ok(paths) = default_paths() else {
        return false;
    };
    let Ok(conn) = ready_connection(&paths) else {
        return false;
    };
    match delete_creation_local(&conn, &paths, id) {
        Ok(()) => {
            let _ = app.emit("library-creation-deleted", id.to_string());
            true
        }
        Err(_) => false,
    }
}

async fn run_cleanup_project_groups(app: &AppHandle, job: &Job) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;
    let images = payload_str_or_null(&payload, "imagesGroupId").unwrap_or(None);
    let videos = payload_str_or_null(&payload, "videosGroupId").unwrap_or(None);
    let pending = payload_str_or_null(&payload, "pendingCreationId").unwrap_or(None);
    let hint_members: Vec<String> = payload
        .get("memberIds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let mut queue: HashSet<String> = HashSet::new();
    for id in [&images, &videos, &pending].into_iter().flatten() {
        queue.insert(id.clone());
    }
    for mid in &hint_members {
        queue.insert(mid.clone());
    }

    for group_id in [&images, &videos].into_iter().flatten() {
        let members = resolve_group_member_ids_for_cleanup(group_id).await;
        if members.is_empty() {
            let note = format!(
                "No members found for group {group_id} (remote or local) — will still try delete cover."
            );
            patch_job(app, &job.id, Some("running"), Some(&note), None, None, None)?;
        }
        for mid in members {
            if mid != *group_id {
                queue.insert(mid);
            }
        }
    }

    let mut ordered: Vec<String> = queue.into_iter().collect();
    ordered.sort_by(|a, b| {
        let a_g = (Some(a) == images.as_ref() || Some(a) == videos.as_ref()) as u8;
        let b_g = (Some(b) == images.as_ref() || Some(b) == videos.as_ref()) as u8;
        a_g.cmp(&b_g)
    });

    let cleaned: Vec<String> = ordered.clone();
    let mut deleted = Vec::new();
    let mut local_deleted = Vec::new();
    let mut messages = Vec::new();
    for id in ordered {
        throw_if_cancelled(&job.id)?;
        let note = format!("Deleting {id} on Parascene…");
        messages.push(note.clone());
        patch_job(app, &job.id, Some("running"), Some(&note), None, None, None)?;
        match delete_creation(&id).await {
            Ok(()) => {
                deleted.push(id.clone());
                let ok = format!("Deleted {id} on Parascene.");
                messages.push(ok.clone());
                patch_job(app, &job.id, Some("running"), Some(&ok), None, None, None)?;
            }
            Err(err) => {
                let fail = format!("Parascene delete {id} failed: {err}");
                messages.push(fail.clone());
                patch_job(app, &job.id, Some("running"), Some(&fail), None, None, None)?;
            }
        }

        // Always purge Library catalog / local files so Assets and sync stay clean
        // even when the remote row was already gone or delete failed.
        if delete_local_best_effort(app, &id) {
            local_deleted.push(id.clone());
            let local_ok = format!("Removed {id} from local Library.");
            messages.push(local_ok.clone());
            patch_job(
                app,
                &job.id,
                Some("running"),
                Some(&local_ok),
                None,
                None,
                None,
            )?;
        }
    }

    if cleaned.is_empty() {
        messages.push("Nothing to delete (no group / member ids).".into());
    } else {
        messages.push(format!(
            "Cleanup finished — Parascene {} / local Library {} of {} target(s).",
            deleted.len(),
            local_deleted.len(),
            cleaned.len()
        ));
    }

    Ok(json!({
        "cleanedIds": cleaned,
        "deletedIds": deleted,
        "localDeletedIds": local_deleted,
        "messages": messages,
    }))
}

async fn run_ensure_project_groups(app: &AppHandle, job: &Job) -> Result<Value, String> {
    let mut payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;

    // After process restart, prefer checkpoint pending/group ids over stale enqueue payload.
    if let Some(raw) = job.checkpoint_json.as_deref() {
        if let Ok(checkpoint) = serde_json::from_str::<Value>(raw) {
            if let Some(v) = checkpoint.get("pendingCreationId") {
                payload["pendingCreationId"] = v.clone();
            }
            if let Some(v) = checkpoint.get("imagesGroupId") {
                payload["imagesGroupId"] = v.clone();
            }
            if let Some(v) = checkpoint.get("videosGroupId") {
                payload["videosGroupId"] = v.clone();
            }
        }
    }

    let mut ctx = EnsureCtx {
        job_id: job.id.clone(),
        project_id: job
            .project_id
            .clone()
            .or_else(|| payload_str(&payload, "projectId")),
        project_title: payload_str(&payload, "projectTitle").unwrap_or_else(|| "Project".into()),
        aspect_ratio: payload_str(&payload, "aspectRatio").unwrap_or_else(|| "16:9".into()),
        still_prompt: payload_str(&payload, "stillPrompt")
            .unwrap_or_else(|| "cinematic still".into()),
        animate_prompt: payload_str(&payload, "animatePrompt")
            .unwrap_or_else(|| "subtle natural motion".into()),
        images_group_id: payload_str_or_null(&payload, "imagesGroupId").unwrap_or(None),
        videos_group_id: payload_str_or_null(&payload, "videosGroupId").unwrap_or(None),
        pending_creation_id: payload_str_or_null(&payload, "pendingCreationId").unwrap_or(None),
        project_creation_ids: Vec::new(),
        messages: Vec::new(),
    };

    // "images" | "videos" | "both" (default) — Lab Kind selector runs one side at a time.
    let mode = payload_str(&payload, "mode").unwrap_or_else(|| "both".into());
    let do_images = mode == "images" || mode == "both";
    let do_videos = mode == "videos" || mode == "both";
    if !do_images && !do_videos {
        return Err(format!("ensure mode must be images, videos, or both (got {mode})"));
    }

    if let Some(pending) = ctx.pending_creation_id.clone() {
        note(
            app,
            &mut ctx,
            &format!("Resuming wait for creation {pending} from previous run…"),
        )
        .await?;
        set_pending(app, &mut ctx, Some(pending.clone())).await?;
        match wait_creation_loop(app, &ctx.job_id, &pending, 20 * 60_000, |_| Ok(())).await {
            Ok(done) => {
                if creation_status(&done) != "failed" {
                    note(
                        app,
                        &mut ctx,
                        &format!(
                            "Resumed creation {} is ready ({}).",
                            creation_id(&done).unwrap_or(pending),
                            creation_status(&done)
                        ),
                    )
                    .await?;
                } else {
                    note(
                        app,
                        &mut ctx,
                        &format!("Resumed creation {pending} failed — continuing ensure."),
                    )
                    .await?;
                }
            }
            Err(err) if err == "Cancelled" => {
                set_pending(app, &mut ctx, None).await?;
                return Err(err);
            }
            Err(err) => {
                note(
                    app,
                    &mut ctx,
                    &format!("Resume wait failed ({err}) — continuing ensure."),
                )
                .await?;
            }
        }
        set_pending(app, &mut ctx, None).await?;
    }

    let images_to_verify = ctx.images_group_id.clone();
    // Videos needs a live Images group for the still; images mode only verifies Images.
    if do_images || do_videos {
        ctx.images_group_id = verify_live_group(app, &mut ctx, images_to_verify, "Images").await?;
        throw_if_cancelled(&ctx.job_id)?;
    }
    if do_videos {
        if ctx.images_group_id.is_none() {
            return Err(
                "Videos ensure requires an Images group first. Run Ensure Images group."
                    .into(),
            );
        }
        let videos_to_verify = ctx.videos_group_id.clone();
        ctx.videos_group_id = verify_live_group(app, &mut ctx, videos_to_verify, "Videos").await?;
        throw_if_cancelled(&ctx.job_id)?;
    }

    // —— Images ——
    let primary_image_id: Option<String> = if do_images {
        let group_id = ctx.images_group_id.clone();
        let member_ids = match &group_id {
            Some(gid) => load_group_member_ids(gid).await,
            None => Vec::new(),
        };
        let images_result: Result<(String, String), String> = if !member_ids.is_empty() {
            let gid = group_id.expect("members imply group id");
            note(
                app,
                &mut ctx,
                &format!(
                    "Images: group {gid} already has {} member(s).",
                    member_ids.len()
                ),
            )
            .await?;
            Ok((gid, member_ids[0].clone()))
        } else {
            if group_id.is_some() {
                note(
                    app,
                    &mut ctx,
                    "Images: group is empty — minting a fresh member.",
                )
                .await?;
            } else {
                note(
                    app,
                    &mut ctx,
                    "Images: no live group — minting a fresh image and group.",
                )
                .await?;
            }
            match create_image_seed(app, &mut ctx).await {
                Ok(member_id) => {
                    throw_if_cancelled(&ctx.job_id)?;
                    set_pending(app, &mut ctx, None).await?;
                    note(app, &mut ctx, "Images: grouping the one image…").await?;
                    match group_members(
                        app,
                        &ctx.project_title,
                        ctx.project_id.as_deref(),
                        "images",
                        group_id.as_deref(),
                        &[member_id.clone()],
                    )
                    .await
                    {
                        Ok(gid) => Ok((gid, member_id)),
                        Err(err) => Err(err),
                    }
                }
                Err(err) => Err(err),
            }
        };

        match images_result {
            Ok((gid, mid)) => {
                ctx.images_group_id = Some(gid.clone());
                note(
                    app,
                    &mut ctx,
                    &format!("Images: 1 image ({mid}) in group {gid}."),
                )
                .await?;
                // Cover + members — Editor needs members as selectable project assets.
                let mut ids = vec![gid.clone()];
                for m in load_group_member_ids(&gid).await {
                    if !ids.iter().any(|x| x == &m) {
                        ids.push(m);
                    }
                }
                if !ids.iter().any(|x| x == &mid) {
                    ids.push(mid.clone());
                }
                ctx.project_creation_ids = ids;
                patch_job(
                    app,
                    &ctx.job_id,
                    Some("running"),
                    ctx.messages.last().map(|s| s.as_str()),
                    Some(&ctx.checkpoint()),
                    None,
                    None,
                )?;
                Some(mid)
            }
            Err(err) if err == "Cancelled" => {
                set_pending(app, &mut ctx, None).await?;
                return Err(err);
            }
            Err(err) => {
                ctx.images_group_id = None;
                set_pending(app, &mut ctx, None).await?;
                note(app, &mut ctx, &format!("Images failed: {err}")).await?;
                None
            }
        }
    } else if do_videos {
        // Videos-only: reuse the newest/first Images member as the i2v still.
        let images_gid = ctx.images_group_id.clone();
        match images_gid {
            Some(gid) => {
                let members = load_group_member_ids(&gid).await;
                let mid = members.first().cloned();
                if let Some(ref id) = mid {
                    note(
                        app,
                        &mut ctx,
                        &format!("Videos: using Images group still {id} from {gid}."),
                    )
                    .await?;
                }
                mid
            }
            None => None,
        }
    } else {
        None
    };

    throw_if_cancelled(&ctx.job_id)?;

    // —— Videos ——
    if do_videos {
        let group_id = ctx.videos_group_id.clone();
        let member_ids = match &group_id {
            Some(gid) => load_group_member_ids(gid).await,
            None => Vec::new(),
        };
        let videos_result: Result<(String, String), String> = if !member_ids.is_empty() {
            let gid = group_id.expect("members imply group id");
            note(
                app,
                &mut ctx,
                &format!(
                    "Videos: group {gid} already has {} member(s).",
                    member_ids.len()
                ),
            )
            .await?;
            Ok((gid, member_ids[0].clone()))
        } else {
            if group_id.is_some() {
                note(
                    app,
                    &mut ctx,
                    "Videos: group is empty — minting a fresh member.",
                )
                .await?;
            } else {
                note(
                    app,
                    &mut ctx,
                    "Videos: no live group — minting a fresh video and group.",
                )
                .await?;
            }

            let mint: Result<String, String> = async {
                note(
                    app,
                    &mut ctx,
                    "Videos: using the Images still (no second seed image)…",
                )
                .await?;
                let primary = primary_image_id.clone();
                let images_gid = ctx.images_group_id.clone();
                let (still_url, emergency_id) =
                    resolve_still_for_video(app, &mut ctx, primary.as_deref()).await?;
                if let (Some(created), Some(ig)) = (emergency_id, images_gid.as_deref()) {
                    note(
                        app,
                        &mut ctx,
                        &format!("Videos: filing emergency still {created} into Images group…"),
                    )
                    .await?;
                    let _ = group_members(
                        app,
                        &ctx.project_title,
                        ctx.project_id.as_deref(),
                        "images",
                        Some(ig),
                        &[created],
                    )
                    .await;
                }
                throw_if_cancelled(&ctx.job_id)?;
                note(app, &mut ctx, "Videos: animating the still (image→video)…").await?;
                match create_video_from_still(app, &mut ctx, &still_url).await {
                    Ok(id) => Ok(id),
                    Err(err) if err == "Cancelled" => Err(err),
                    Err(err) => {
                        note(
                            app,
                            &mut ctx,
                            &format!("Videos: image→video failed ({err}); trying text→video…"),
                        )
                        .await?;
                        create_text_video_seed(app, &mut ctx).await
                    }
                }
            }
            .await;

            match mint {
                Ok(member_id) => {
                    throw_if_cancelled(&ctx.job_id)?;
                    set_pending(app, &mut ctx, None).await?;
                    note(app, &mut ctx, "Videos: grouping the one video…").await?;
                    match group_members(
                        app,
                        &ctx.project_title,
                        ctx.project_id.as_deref(),
                        "videos",
                        group_id.as_deref(),
                        &[member_id.clone()],
                    )
                    .await
                    {
                        Ok(gid) => Ok((gid, member_id)),
                        Err(err) => Err(err),
                    }
                }
                Err(err) => Err(err),
            }
        };

        match videos_result {
            Ok((gid, mid)) => {
                ctx.videos_group_id = Some(gid.clone());
                note(
                    app,
                    &mut ctx,
                    &format!("Videos: 1 video ({mid}) in group {gid}."),
                )
                .await?;
                // Covers + members — Editor needs members as selectable assets.
                let mut ids = Vec::new();
                if let Some(ig) = &ctx.images_group_id {
                    ids.push(ig.clone());
                    for m in load_group_member_ids(ig).await {
                        if !ids.iter().any(|x| x == &m) {
                            ids.push(m);
                        }
                    }
                }
                ids.push(gid.clone());
                for m in load_group_member_ids(&gid).await {
                    if !ids.iter().any(|x| x == &m) {
                        ids.push(m);
                    }
                }
                if !ids.iter().any(|x| x == &mid) {
                    ids.push(mid);
                }
                ctx.project_creation_ids = ids;
                patch_job(
                    app,
                    &ctx.job_id,
                    Some("running"),
                    ctx.messages.last().map(|s| s.as_str()),
                    Some(&ctx.checkpoint()),
                    None,
                    None,
                )?;
            }
            Err(err) if err == "Cancelled" => {
                set_pending(app, &mut ctx, None).await?;
                return Err(err);
            }
            Err(err) => {
                ctx.videos_group_id = None;
                set_pending(app, &mut ctx, None).await?;
                note(app, &mut ctx, &format!("Videos failed: {err}")).await?;
            }
        }
    }

    throw_if_cancelled(&ctx.job_id)?;

    let mut canonical = Vec::new();
    if let Some(id) = &ctx.images_group_id {
        canonical.push(id.clone());
        for mid in load_group_member_ids(id).await {
            if !canonical.iter().any(|x| x == &mid) {
                canonical.push(mid);
            }
        }
    }
    if let Some(id) = &ctx.videos_group_id {
        canonical.push(id.clone());
        for mid in load_group_member_ids(id).await {
            if !canonical.iter().any(|x| x == &mid) {
                canonical.push(mid);
            }
        }
    }
    ctx.project_creation_ids = canonical.clone();
    ctx.pending_creation_id = None;
    patch_job(
        app,
        &ctx.job_id,
        Some("running"),
        Some("Ensure finished."),
        Some(&ctx.checkpoint()),
        None,
        None,
    )?;

    Ok(json!({
        "imagesGroupId": ctx.images_group_id,
        "videosGroupId": ctx.videos_group_id,
        "projectCreationIds": canonical,
        "messages": ctx.messages,
        "mode": mode,
    }))
}

async fn run_create_media(app: &AppHandle, job: &Job) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;
    let server_id = payload
        .get("serverId")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "create_media requires serverId".to_string())?;
    let method = payload_str(&payload, "method").ok_or_else(|| "create_media requires method")?;
    let args = payload.get("args").cloned().unwrap_or(json!({}));
    let token = payload_str(&payload, "creationToken").unwrap_or_else(new_creation_token);
    let wait = payload
        .get("wait")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let timeout_ms = payload
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(20 * 60_000);

    let started = create_media(CreateOpts {
        server_id,
        method,
        args,
        creation_token: token,
        mutate_of_id: payload.get("mutateOfId").and_then(|v| v.as_i64()),
        group_id: payload.get("groupId").and_then(|v| v.as_i64()),
    })
    .await?;
    let id = creation_id(&started).ok_or_else(|| "create missing id".to_string())?;
    let checkpoint = json!({ "pendingCreationId": id, "creationId": id });
    patch_job(
        app,
        &job.id,
        Some("waiting"),
        Some(&format!("Created {id}; waiting…")),
        Some(&checkpoint),
        None,
        None,
    )?;

    if !wait {
        return Ok(json!({ "creationId": id, "status": creation_status(&started) }));
    }

    let done = wait_creation_loop(app, &job.id, &id, timeout_ms, |_| Ok(())).await?;
    Ok(json!({
        "creationId": id,
        "status": creation_status(&done),
        "creation": done,
    }))
}

async fn run_wait_creation(app: &AppHandle, job: &Job) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;
    let id = payload_str(&payload, "creationId")
        .ok_or_else(|| "wait_creation requires creationId".to_string())?;
    let timeout_ms = payload
        .get("timeoutMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(20 * 60_000);
    let checkpoint = json!({ "pendingCreationId": id, "creationId": id });
    patch_job(
        app,
        &job.id,
        Some("waiting"),
        Some(&format!("Waiting for {id}…")),
        Some(&checkpoint),
        None,
        None,
    )?;
    let done = wait_creation_loop(app, &job.id, &id, timeout_ms, |_| Ok(())).await?;
    Ok(json!({
        "creationId": id,
        "status": creation_status(&done),
        "creation": done,
    }))
}

async fn run_group_creations(app: &AppHandle, job: &Job) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;
    let ids: Vec<String> = payload
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| match v {
                    Value::String(s) => Some(s.trim().to_string()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Err("group_creations requires ids".into());
    }
    let party = payload_str(&payload, "partyName");
    let meta = payload.get("meta").cloned();
    let grouped = group_creations(&ids, party.as_deref(), meta.as_ref()).await?;
    let group_id = creation_id(&grouped).ok_or_else(|| "group missing id".to_string())?;
    let full = get_creation(&group_id).await?;
    ingest_and_warm(app, &full).await;
    Ok(json!({ "groupId": group_id, "creation": full }))
}

async fn run_delete_creation(_app: &AppHandle, job: &Job) -> Result<Value, String> {
    let payload: Value =
        serde_json::from_str(&job.payload_json).map_err(|e| format!("bad payload: {e}"))?;
    let id =
        payload_str(&payload, "creationId").ok_or_else(|| "delete_creation requires creationId")?;
    delete_creation(&id).await?;
    Ok(json!({ "deletedId": id }))
}

async fn run_job(app: &AppHandle, job: Job) {
    let id = job.id.clone();
    clear_cancel_request(&id);
    if let Err(err) = patch_job(app, &id, Some("running"), Some("Starting…"), None, None, None)
    {
        eprintln!("[jobs] failed to mark running: {err}");
        return;
    }

    let result = match job.kind.as_str() {
        "ensure_project_groups" => run_ensure_project_groups(app, &job).await,
        "cleanup_project_groups" => run_cleanup_project_groups(app, &job).await,
        "create_media" => run_create_media(app, &job).await,
        "wait_creation" => run_wait_creation(app, &job).await,
        "group_creations" => run_group_creations(app, &job).await,
        "delete_creation" => run_delete_creation(app, &job).await,
        other => Err(format!("unknown job kind: {other}")),
    };

    match result {
        Ok(value) => {
            let _ = patch_job(
                app,
                &id,
                Some("done"),
                Some("Done"),
                None,
                Some(&value),
                None,
            );
            clear_cancel_request(&id);
        }
        Err(err) if err == "Cancelled" || is_cancel_requested(&id) => {
            let _ = patch_job(
                app,
                &id,
                Some("cancelled"),
                Some("Cancelled"),
                None,
                None,
                Some("Cancelled"),
            );
            clear_cancel_request(&id);
        }
        Err(err) => {
            let _ = patch_job(
                app,
                &id,
                Some("failed"),
                Some(&err),
                None,
                None,
                Some(&err),
            );
            clear_cancel_request(&id);
        }
    }
}

fn recover_interrupted_jobs(conn: &Connection) -> Result<(), String> {
    // Process died mid-run: re-queue so the worker can resume from checkpoint.
    conn.execute(
        "UPDATE jobs SET status = 'queued', updated_at = ?1
         WHERE status IN ('running', 'waiting')",
        params![now_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn claim_next_job(conn: &Connection) -> Result<Option<Job>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{JOB_SELECT} WHERE status = 'queued'
             ORDER BY created_at ASC LIMIT 1"
        ))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let job = row_from_query(row).map_err(|e| e.to_string())?;
        update_job_fields(conn, &job.id, Some("running"), None, None, None, None)?;
        get_job_conn(conn, &job.id)
    } else {
        Ok(None)
    }
}

async fn jobs_worker(app: AppHandle) {
    if let Err(err) = with_conn(recover_interrupted_jobs) {
        eprintln!("[jobs] recover failed: {err}");
    }
    loop {
        let next = with_conn(claim_next_job);
        let job = match next {
            Ok(Some(j)) => j,
            Ok(None) => {
                if let Ok(mut state) = runner_state().lock() {
                    state.running = false;
                }
                return;
            }
            Err(err) => {
                eprintln!("[jobs] claim failed: {err}");
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };
        run_job(&app, job).await;
    }
}

fn start_jobs_worker(app: AppHandle) {
    let mut start = false;
    if let Ok(mut state) = runner_state().lock() {
        if !state.running {
            state.running = true;
            start = true;
        }
    }
    if start {
        tauri::async_runtime::spawn(async move {
            jobs_worker(app).await;
        });
    }
}

#[tauri::command]
pub fn jobs_enqueue(app: AppHandle, request: EnqueueJobRequest) -> Result<Job, String> {
    let kind = request.kind.trim().to_string();
    if kind.is_empty() {
        return Err("kind is required".into());
    }
    let known = [
        "ensure_project_groups",
        "cleanup_project_groups",
        "create_media",
        "wait_creation",
        "group_creations",
        "delete_creation",
    ];
    if !known.contains(&kind.as_str()) {
        return Err(format!("unknown job kind: {kind}"));
    }

    let now = now_rfc3339();
    let job = Job {
        id: Uuid::new_v4().to_string(),
        kind,
        status: "queued".into(),
        project_id: request.project_id,
        label: request.label,
        payload_json: serde_json::to_string(&request.payload).unwrap_or_else(|_| "{}".into()),
        result_json: None,
        checkpoint_json: None,
        progress_note: Some("Queued".into()),
        error: None,
        created_at: now.clone(),
        updated_at: now,
    };
    with_conn(|conn| insert_job(conn, &job))?;
    emit_job(&app, &job);
    start_jobs_worker(app);
    Ok(job)
}

#[tauri::command]
pub fn jobs_get(id: String) -> Result<Option<Job>, String> {
    with_conn(|conn| get_job_conn(conn, &id))
}

#[tauri::command]
pub fn jobs_list(
    project_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<Job>, String> {
    let lim = limit.unwrap_or(50).clamp(1, 200) as i64;
    with_conn(|conn| {
        let mut jobs = Vec::new();
        if let (Some(pid), Some(st)) = (project_id.as_ref(), status.as_ref()) {
            let mut stmt = conn
                .prepare(&format!(
                    "{JOB_SELECT} WHERE project_id = ?1 AND status = ?2
                     ORDER BY created_at DESC LIMIT ?3"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![pid, st, lim], row_from_query)
                .map_err(|e| e.to_string())?;
            for row in rows {
                jobs.push(row.map_err(|e| e.to_string())?);
            }
        } else if let Some(pid) = project_id.as_ref() {
            let mut stmt = conn
                .prepare(&format!(
                    "{JOB_SELECT} WHERE project_id = ?1
                     ORDER BY created_at DESC LIMIT ?2"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![pid, lim], row_from_query)
                .map_err(|e| e.to_string())?;
            for row in rows {
                jobs.push(row.map_err(|e| e.to_string())?);
            }
        } else if let Some(st) = status.as_ref() {
            let mut stmt = conn
                .prepare(&format!(
                    "{JOB_SELECT} WHERE status = ?1
                     ORDER BY created_at DESC LIMIT ?2"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![st, lim], row_from_query)
                .map_err(|e| e.to_string())?;
            for row in rows {
                jobs.push(row.map_err(|e| e.to_string())?);
            }
        } else {
            let mut stmt = conn
                .prepare(&format!(
                    "{JOB_SELECT} ORDER BY created_at DESC LIMIT ?1"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![lim], row_from_query)
                .map_err(|e| e.to_string())?;
            for row in rows {
                jobs.push(row.map_err(|e| e.to_string())?);
            }
        }
        Ok(jobs)
    })
}

#[tauri::command]
pub fn jobs_cancel(app: AppHandle, id: String) -> Result<Job, String> {
    mark_cancel_request(&id);
    with_conn(|conn| {
        let job = get_job_conn(conn, &id)?.ok_or_else(|| format!("job {id} not found"))?;
        if matches!(job.status.as_str(), "done" | "failed" | "cancelled") {
            return Ok(job);
        }
        // If still queued, mark cancelled immediately.
        if job.status == "queued" {
            update_job_fields(
                conn,
                &id,
                Some("cancelled"),
                Some("Cancelled"),
                None,
                None,
                Some("Cancelled"),
            )?;
        }
        get_job_conn(conn, &id)?.ok_or_else(|| format!("job {id} not found"))
    })
    .map(|job| {
        emit_job(&app, &job);
        // Kick worker so a waiting job notices cancel via flag; also drains queue.
        start_jobs_worker(app);
        job
    })
}
