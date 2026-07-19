use super::catalog::{
    clear_local_thumb_paths, default_paths, delete_creation_local, get_creation_by_id,
    get_creations_by_ids, list_creations, list_creations_page, mark_downloaded, ready_connection,
    set_download_state, set_local_thumb_path, sync_status_for, Creation, SyncStatus,
};
use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Pages of thumbs to warm ahead of the requested list offset (stay in front of scroll).
const THUMB_AHEAD_PAGES: u32 = 14;
/// Concurrent thumb HTTP fetches — keep modest to avoid CDN/API rate limits.
const THUMB_CONCURRENCY: usize = 10;
/// Retry budget for transient HTTP failures (429 / 503).
const DOWNLOAD_MAX_ATTEMPTS: u32 = 5;
/// Base pacing between media GETs in bulk sync (grows after 429s).
const MEDIA_PACE_MS: u64 = 200;
const MEDIA_PACE_MAX_MS: u64 = 15_000;
/// Stop a bulk media run after this many consecutive download failures.
const MEDIA_FAIL_STREAK_ABORT: u32 = 3;
/// Auth / rate-limit failures abort sooner — the rest of the queue will look the same.
const MEDIA_SYSTEMIC_FAIL_ABORT: u32 = 2;

fn is_systemic_download_err(err: &str) -> bool {
    err.contains("HTTP 401")
        || err.contains("HTTP 403")
        || err.contains("HTTP 429")
        || err.contains("sign in")
        || err.contains("session rejected")
        || err.contains("Token refresh")
        || err.contains("Not signed in")
}

fn media_fail_should_abort(streak: u32, err: &str) -> bool {
    if is_systemic_download_err(err) {
        streak >= MEDIA_SYSTEMIC_FAIL_ABORT
    } else {
        streak >= MEDIA_FAIL_STREAK_ABORT
    }
}

fn skip_remaining_media(
    app: &AppHandle,
    remaining: impl IntoIterator<Item = Creation>,
    reason: &str,
    skipped: &mut u32,
) {
    for creation in remaining {
        {
            if let Ok(paths) = default_paths() {
                if let Ok(conn) = ready_connection(&paths) {
                    if creation.download_state == "downloading" {
                        let _ = set_download_state(&conn, &creation.id, "remote");
                        emit_creation_updated(app, &creation.id);
                    }
                }
            }
        }
        emit_sync_item_detail(app, &creation, "media", "skipped", Some(reason.to_string()));
        *skipped += 1;
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .pool_max_idle_per_host(4)
            // Cloudflare (and some edges) reject bare reqwest UA signatures.
            .user_agent("ParasceneDesktop/0.1 (Macintosh; Tauri)")
            .build()
            .expect("reqwest client")
    })
}

/// Shared adaptive delay for bulk media pulls (Sync page / ensure queue).
fn media_pace_ms() -> &'static Mutex<u64> {
    static PACE: OnceLock<Mutex<u64>> = OnceLock::new();
    PACE.get_or_init(|| Mutex::new(MEDIA_PACE_MS))
}

async fn pace_media_download() {
    let ms = media_pace_ms().lock().map(|g| *g).unwrap_or(MEDIA_PACE_MS);
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
}

fn note_media_rate_limited() {
    if let Ok(mut g) = media_pace_ms().lock() {
        *g = (*g).saturating_mul(2).clamp(500, MEDIA_PACE_MAX_MS);
        eprintln!("[library] rate limited — media pace now {}ms", *g);
    }
}

fn note_media_ok() {
    if let Ok(mut g) = media_pace_ms().lock() {
        // Ease back toward the base gap after successes.
        *g = ((*g as f64) * 0.85) as u64;
        if *g < MEDIA_PACE_MS {
            *g = MEDIA_PACE_MS;
        }
    }
}

fn retry_after_delay(res: &reqwest::Response) -> Duration {
    if let Some(raw) = res
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
    {
        if let Ok(secs) = raw.parse::<u64>() {
            return Duration::from_secs(secs.clamp(1, 60));
        }
    }
    Duration::from_secs(2)
}

fn format_http_err(status: u16) -> String {
    if status == 429 {
        "HTTP 429 (rate limited)".into()
    } else if status == 503 {
        "HTTP 503 (unavailable)".into()
    } else {
        format!("HTTP {status}")
    }
}

/// Queue lanes (worker order):
/// 1. `media_urgent` — lightbox click (beats everything)
/// 2. thumbs (board warmth)
/// 3. media_high / media_low
struct EnsureQueue {
    media_urgent: VecDeque<String>,
    thumbs_high: VecDeque<String>,
    thumbs_low: VecDeque<String>,
    media_high: VecDeque<String>,
    media_low: VecDeque<String>,
    thumbs_queued: HashSet<String>,
    media_queued: HashSet<String>,
    running: bool,
}

impl EnsureQueue {
    fn new() -> Self {
        Self {
            media_urgent: VecDeque::new(),
            thumbs_high: VecDeque::new(),
            thumbs_low: VecDeque::new(),
            media_high: VecDeque::new(),
            media_low: VecDeque::new(),
            thumbs_queued: HashSet::new(),
            media_queued: HashSet::new(),
            running: false,
        }
    }

    fn enqueue_thumb(&mut self, id: String, priority: bool) {
        if self.thumbs_queued.contains(&id) {
            if priority {
                self.thumbs_low.retain(|x| x != &id);
                self.thumbs_high.retain(|x| x != &id);
                self.thumbs_high.push_front(id);
            }
            return;
        }
        self.thumbs_queued.insert(id.clone());
        if priority {
            self.thumbs_high.push_front(id);
        } else {
            self.thumbs_low.push_back(id);
        }
    }

    fn enqueue_media(&mut self, id: String, priority: bool) {
        if self.media_queued.contains(&id) {
            if priority {
                // Promote out of low → high (but not above urgent).
                self.media_low.retain(|x| x != &id);
                if !self.media_urgent.iter().any(|x| x == &id)
                    && !self.media_high.iter().any(|x| x == &id)
                {
                    self.media_high.push_front(id);
                }
            }
            return;
        }
        self.media_queued.insert(id.clone());
        if priority {
            self.media_high.push_front(id);
        } else {
            self.media_low.push_back(id);
        }
    }

    /// Lightbox open — jump the entire queue.
    fn enqueue_media_urgent(&mut self, id: String) {
        self.media_low.retain(|x| x != &id);
        self.media_high.retain(|x| x != &id);
        self.media_urgent.retain(|x| x != &id);
        self.media_queued.insert(id.clone());
        self.media_urgent.push_front(id);
    }
}

fn ensure_queue() -> &'static Mutex<EnsureQueue> {
    static Q: OnceLock<Mutex<EnsureQueue>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(EnsureQueue::new()))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub done: u32,
    pub total: u32,
    pub current_id: Option<String>,
    pub failed: u32,
    pub phase: String,
}

/// Per-item sync activity for the Sync page live list.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItemEvent {
    pub id: String,
    pub title: String,
    /// `"thumb"` | `"media"`
    pub kind: String,
    /// `"queued"` | `"active"` | `"done"` | `"failed"` | `"skipped"`
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSummary {
    pub downloaded: u32,
    pub failed: u32,
    pub skipped: u32,
    pub status: SyncStatus,
}

fn extension_for(url: &str, media_type: &str, content_type: Option<&str>) -> String {
    if let Some(ct) = content_type {
        let ct = ct
            .split(';')
            .next()
            .unwrap_or(ct)
            .trim()
            .to_ascii_lowercase();
        if let Some(ext) = match ct.as_str() {
            "image/jpeg" | "image/jpg" => Some("jpg"),
            "image/png" => Some("png"),
            "image/webp" => Some("webp"),
            "image/gif" => Some("gif"),
            "video/mp4" => Some("mp4"),
            "video/webm" => Some("webm"),
            "audio/mpeg" | "audio/mp3" => Some("mp3"),
            "audio/wav" | "audio/x-wav" => Some("wav"),
            _ => None,
        } {
            return ext.to_string();
        }
    }

    let path_part = url.split('?').next().unwrap_or(url);
    if let Some(name) = path_part.rsplit('/').next() {
        if let Some((_, ext)) = name.rsplit_once('.') {
            let ext = ext.to_ascii_lowercase();
            if (2..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
                return ext;
            }
        }
    }

    match media_type {
        "video" => "mp4".into(),
        "audio" => "wav".into(),
        _ => "bin".into(),
    }
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[derive(Debug)]
enum DownloadAttemptErr {
    /// Retryable with optional server-suggested wait.
    Retryable {
        message: String,
        wait: Duration,
    },
    Fatal(String),
}

async fn download_url_once(
    url: &str,
    media_type: &str,
    dest_dir: &Path,
    stem: &str,
    bearer: Option<&str>,
) -> Result<PathBuf, DownloadAttemptErr> {
    let mut req = http_client().get(url);
    if let Some(token) = bearer {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let res = req
        .send()
        .await
        .map_err(|e| DownloadAttemptErr::Fatal(format!("Download failed: {e}")))?;
    let status = res.status();
    if status.as_u16() == 429 || status.as_u16() == 503 {
        let wait = retry_after_delay(&res);
        return Err(DownloadAttemptErr::Retryable {
            message: format_http_err(status.as_u16()),
            wait,
        });
    }
    if !status.is_success() {
        return Err(DownloadAttemptErr::Fatal(format_http_err(status.as_u16())));
    }
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let ext = extension_for(url, media_type, content_type.as_deref());
    let dest = dest_dir.join(format!("{stem}.{ext}"));

    tokio::fs::create_dir_all(dest_dir).await.map_err(|e| {
        DownloadAttemptErr::Fatal(format!("Could not create {}: {e}", dest_dir.display()))
    })?;

    let mut file = tokio::fs::File::create(&dest).await.map_err(|e| {
        DownloadAttemptErr::Fatal(format!("Could not write {}: {e}", dest.display()))
    })?;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| DownloadAttemptErr::Fatal(format!("Download stream error: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| DownloadAttemptErr::Fatal(format!("Write failed: {e}")))?;
    }
    file.flush()
        .await
        .map_err(|e| DownloadAttemptErr::Fatal(format!("Flush failed: {e}")))?;
    Ok(dest)
}

async fn download_url_authed_or_public(
    url: &str,
    media_type: &str,
    dest_dir: &Path,
    stem: &str,
) -> Result<PathBuf, DownloadAttemptErr> {
    // Refresh near-expired JWTs before the first authenticated media GET.
    let token = match crate::auth_store::ensure_access_token().await {
        Ok(t) => Some(t),
        Err(err) => {
            eprintln!("[library] auth for download: {err}");
            // Dead / missing session: fail fast. Trying anonymous for every thumb
            // in a concurrent batch is what made the app feel stuck after logout
            // or refresh-token invalidation.
            if is_systemic_download_err(&err) || err.contains("Session expired") {
                return Err(DownloadAttemptErr::Fatal(format!(
                    "{err} (session rejected — try logging out/in)"
                )));
            }
            None
        }
    };

    if let Some(token) = token.as_deref() {
        match download_url_once(url, media_type, dest_dir, stem, Some(token)).await {
            Ok(path) => return Ok(path),
            Err(DownloadAttemptErr::Retryable { message, wait }) => {
                return Err(DownloadAttemptErr::Retryable { message, wait });
            }
            Err(DownloadAttemptErr::Fatal(err)) => {
                let auth_denied = err.contains("HTTP 401") || err.contains("HTTP 403");
                if !auth_denied {
                    return Err(DownloadAttemptErr::Fatal(err));
                }
                // One forced refresh if soft-ensure still left us with a rejected JWT.
                // Serialized in auth_store so this won't race with FE.
                if let Ok(fresh) = crate::auth_store::force_refresh_access_token().await {
                    match download_url_once(url, media_type, dest_dir, stem, Some(&fresh)).await {
                        Ok(path) => return Ok(path),
                        Err(DownloadAttemptErr::Retryable { message, wait }) => {
                            return Err(DownloadAttemptErr::Retryable { message, wait });
                        }
                        Err(DownloadAttemptErr::Fatal(_)) => {}
                    }
                }
                // Some public assets still work without auth.
                match download_url_once(url, media_type, dest_dir, stem, None).await {
                    Ok(path) => return Ok(path),
                    Err(DownloadAttemptErr::Retryable { message, wait }) => {
                        return Err(DownloadAttemptErr::Retryable { message, wait });
                    }
                    Err(_) => {
                        return Err(DownloadAttemptErr::Fatal(format!(
                            "{err} (session rejected — try logging out/in)"
                        )));
                    }
                }
            }
        }
    }

    match download_url_once(url, media_type, dest_dir, stem, None).await {
        Ok(path) => Ok(path),
        Err(DownloadAttemptErr::Fatal(err)) => {
            if err.contains("HTTP 401") || err.contains("HTTP 403") {
                Err(DownloadAttemptErr::Fatal(format!(
                    "{err} (sign in required)"
                )))
            } else {
                Err(DownloadAttemptErr::Fatal(err))
            }
        }
        Err(retryable) => Err(retryable),
    }
}

/// Prefer the session bearer when present (unpublished media is 403 anonymously).
/// Retries on 429/503 with backoff / Retry-After.
async fn download_url_with_ext(
    url: &str,
    media_type: &str,
    dest_dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    let mut last_err = String::from("Download failed");
    for attempt in 0..DOWNLOAD_MAX_ATTEMPTS {
        match download_url_authed_or_public(url, media_type, dest_dir, stem).await {
            Ok(path) => return Ok(path),
            Err(DownloadAttemptErr::Retryable { message, wait }) => {
                last_err = message;
                note_media_rate_limited();
                if attempt + 1 >= DOWNLOAD_MAX_ATTEMPTS {
                    break;
                }
                let backoff = wait.saturating_mul(1 + attempt as u32);
                eprintln!(
                    "[library] {last_err} — retry {}/{} after {}ms",
                    attempt + 1,
                    DOWNLOAD_MAX_ATTEMPTS - 1,
                    backoff.as_millis()
                );
                tokio::time::sleep(backoff).await;
            }
            Err(DownloadAttemptErr::Fatal(err)) => return Err(err),
        }
    }
    Err(last_err)
}

/// Media pulls: pace between GETs, then share auth/retry logic.
async fn download_media_file(
    url: &str,
    media_type: &str,
    dest_dir: &Path,
    stem: &str,
) -> Result<PathBuf, String> {
    pace_media_download().await;
    match download_url_with_ext(url, media_type, dest_dir, stem).await {
        Ok(path) => {
            note_media_ok();
            Ok(path)
        }
        Err(err) => Err(err),
    }
}

pub(crate) fn needs_download(c: &Creation) -> bool {
    if c.remote_url.as_deref().unwrap_or("").is_empty() {
        return false;
    }
    match c.download_state.as_str() {
        "local" => c
            .local_path
            .as_ref()
            .map(|p| !Path::new(p).is_file())
            .unwrap_or(true),
        "remote" | "failed" | "queued" | "downloading" => true,
        _ => true,
    }
}

pub(crate) fn needs_thumb(c: &Creation) -> bool {
    if preview_url_for(c).is_none() {
        return false;
    }
    match c.local_thumb_path.as_ref() {
        Some(p) if Path::new(p).is_file() => {
            // Square CDN thumbs stuck on non-square slots (fit URL often 200s with square
            // fallback). Images can heal from full remote_url; videos need a real fit object.
            creation_expects_non_square(c)
                && image_file_is_square_cdn_thumb(Path::new(p))
                && c.media_type == "image"
                && c.remote_url
                    .as_deref()
                    .map(|u| !u.is_empty())
                    .unwrap_or(false)
        }
        _ => true,
    }
}

/// Creations whose board slot is non-square but the local preview is still a square CDN thumb.
pub(crate) fn list_ids_with_mismatched_square_thumbs(
    conn: &rusqlite::Connection,
) -> Result<Vec<String>, String> {
    let rows = list_creations(conn)?;
    let mut out = Vec::new();
    for c in rows {
        let Some(path) = c.local_thumb_path.as_deref().filter(|p| !p.is_empty()) else {
            continue;
        };
        if !Path::new(path).is_file() {
            continue;
        }
        if creation_expects_non_square(&c) && image_file_is_square_cdn_thumb(Path::new(path)) {
            out.push(c.id);
        }
    }
    Ok(out)
}

/// Local-first fit heal plan: prefer disk media over cloud repair POSTs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFitTarget {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFitPlan {
    /// Has local media; rebuild `.fit.jpg` then upload to Parascene.
    pub regenerate: Vec<LocalFitTarget>,
    /// Local `.fit.jpg` already exists; push to cloud if fit URL missing.
    pub upload_only: Vec<LocalFitTarget>,
    /// Non-square images with no local media — server must generate fit.
    pub cloud_repair: Vec<LocalFitTarget>,
}

fn local_file_ok(path: Option<&str>) -> bool {
    path.filter(|p| !p.is_empty())
        .map(|p| Path::new(p).is_file())
        .unwrap_or(false)
}

fn cloud_missing_fit(c: &Creation) -> bool {
    c.fit_thumbnail_url
        .as_deref()
        .map(|u| u.trim().is_empty())
        .unwrap_or(true)
}

fn thumb_is_fit_jpg(path: &str) -> bool {
    path.ends_with(".fit.jpg")
}

fn fit_target(c: &Creation) -> LocalFitTarget {
    LocalFitTarget {
        id: c.id.clone(),
        title: if c.title.trim().is_empty() {
            c.id.clone()
        } else {
            c.title.clone()
        },
    }
}

/// Partition the catalog into local regenerate / upload / server-only repair buckets.
pub(crate) fn build_local_fit_plan(conn: &rusqlite::Connection) -> Result<LocalFitPlan, String> {
    let rows = list_creations(conn)?;
    let mut regenerate = Vec::new();
    let mut upload_only = Vec::new();
    let mut cloud_repair = Vec::new();

    for c in rows {
        let has_media = local_file_ok(c.local_path.as_deref());
        let thumb_path = c.local_thumb_path.as_deref().filter(|p| !p.is_empty());
        let has_thumb = thumb_path.map(|p| Path::new(p).is_file()).unwrap_or(false);
        let is_fit = thumb_path.map(thumb_is_fit_jpg).unwrap_or(false);
        let is_video = c.media_type.eq_ignore_ascii_case("video");
        let expects_ns = creation_expects_non_square(&c);
        let square_wrong = expects_ns
            && has_thumb
            && thumb_path
                .map(|p| image_file_is_square_cdn_thumb(Path::new(p)))
                .unwrap_or(false);
        let missing_cloud_fit = cloud_missing_fit(&c);

        if has_media {
            // Only heal real problems: missing preview, square CDN on a
            // non-square slot, or a non-square video that never got a local fit.
            if !has_thumb || square_wrong || (is_video && expects_ns && !is_fit) {
                regenerate.push(fit_target(&c));
                continue;
            }
            // Push only when we already produced a local `.fit.jpg` and cloud
            // doesn't have it yet — never upload every non-square thumb.
            if is_fit && missing_cloud_fit {
                upload_only.push(fit_target(&c));
            }
            continue;
        }

        // No local media: only images can be repaired server-side from storage.
        // Video posters are often square; skip until the mp4 is downloaded.
        if !is_video && expects_ns && (square_wrong || (!has_thumb && missing_cloud_fit)) {
            cloud_repair.push(fit_target(&c));
        }
    }

    Ok(LocalFitPlan {
        regenerate,
        upload_only,
        cloud_repair,
    })
}

fn creation_expects_non_square(c: &Creation) -> bool {
    if let (Some(w), Some(h)) = (c.width, c.height) {
        if w > 0 && h > 0 {
            let ratio = w as f64 / h as f64;
            if (ratio - 1.0).abs() > 0.08 {
                return true;
            }
        }
    }
    if let Some(ar) = c.aspect_ratio.as_deref() {
        let parts: Vec<_> = ar.split(':').collect();
        if parts.len() == 2 {
            if let (Ok(aw), Ok(ah)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                if aw > 0.0 && ah > 0.0 {
                    return (aw / ah - 1.0).abs() > 0.08;
                }
            }
        }
    }
    false
}

/// Parascene square board thumbs are 250×250 cover crops.
fn image_file_is_square_cdn_thumb(path: &Path) -> bool {
    let Ok((w, h)) = image::image_dimensions(path) else {
        return false;
    };
    if w == 0 || h == 0 {
        return false;
    }
    let max = w.max(h);
    let min = w.min(h);
    max <= 280 && (max as f64 / min as f64) < 1.08
}

fn emit_creation_updated(app: &AppHandle, id: &str) {
    let Ok(paths) = default_paths() else {
        return;
    };
    let Ok(conn) = ready_connection(&paths) else {
        return;
    };
    if let Ok(Some(creation)) = get_creation_by_id(&conn, id) {
        let _ = app.emit("library-creation-updated", creation);
    }
}

fn newest_first(mut items: Vec<Creation>) -> Vec<Creation> {
    items.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    items
}

fn emit_progress(
    app: &AppHandle,
    done: u32,
    total: u32,
    current_id: Option<String>,
    failed: u32,
    phase: &str,
) {
    let _ = app.emit(
        "library-download-progress",
        DownloadProgress {
            done,
            total,
            current_id,
            failed,
            phase: phase.to_string(),
        },
    );
}

fn emit_sync_item(app: &AppHandle, creation: &Creation, kind: &str, state: &str) {
    emit_sync_item_detail(app, creation, kind, state, None);
}

fn emit_sync_item_detail(
    app: &AppHandle,
    creation: &Creation,
    kind: &str,
    state: &str,
    detail: Option<String>,
) {
    let _ = app.emit(
        "library-sync-item",
        SyncItemEvent {
            id: creation.id.clone(),
            title: creation.title.clone(),
            kind: kind.to_string(),
            state: state.to_string(),
            detail,
        },
    );
}

fn emit_sync_items(app: &AppHandle, creations: &[Creation], kind: &str, state: &str) {
    for creation in creations {
        emit_sync_item(app, creation, kind, state);
    }
}

fn short_download_err(err: &str) -> String {
    // Keep activity rows readable — drop long URLs.
    err.split(" (https://")
        .next()
        .unwrap_or(err)
        .trim()
        .chars()
        .take(80)
        .collect()
}

/// Prefer native-aspect fit thumb, then square thumbnail, then full image URL.
fn preview_urls_for(creation: &Creation) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(u) = creation
        .fit_thumbnail_url
        .as_deref()
        .filter(|u| !u.is_empty())
    {
        urls.push(u.to_string());
    }
    if let Some(u) = creation.thumbnail_url.as_deref().filter(|u| !u.is_empty()) {
        urls.push(u.to_string());
    }
    if creation.media_type == "image" {
        if let Some(u) = creation.remote_url.as_deref().filter(|u| !u.is_empty()) {
            if !urls.iter().any(|existing| existing == u) {
                urls.push(u.to_string());
            }
        }
    }
    urls
}

fn preview_url_for(creation: &Creation) -> Option<&str> {
    creation
        .fit_thumbnail_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .or_else(|| creation.thumbnail_url.as_deref().filter(|u| !u.is_empty()))
        .or_else(|| {
            if creation.media_type == "image" {
                creation.remote_url.as_deref().filter(|u| !u.is_empty())
            } else {
                None
            }
        })
}

async fn download_thumbs_only(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    pending: Vec<Creation>,
) -> Result<(u32, HashMap<String, String>), String> {
    let pending = newest_first(pending);
    let total = pending.len() as u32;
    let mut thumb_paths: HashMap<String, String> = HashMap::new();

    if total == 0 {
        return Ok((0, thumb_paths));
    }

    emit_progress(app, 0, total, None, 0, "thumbs");
    emit_sync_items(app, &pending, "thumb", "queued");
    eprintln!("[library] thumb batch start: {total} (concurrency {THUMB_CONCURRENCY})");

    let thumbs_dir = paths.thumbs.clone();
    let app_for_tasks = app.clone();
    let mut stream = stream::iter(pending)
        .map(|creation| {
            let thumbs_dir = thumbs_dir.clone();
            let app = app_for_tasks.clone();
            async move {
                emit_sync_item(&app, &creation, "thumb", "active");
                let id = creation.id.clone();
                let title = creation.title.clone();
                let urls = preview_urls_for(&creation);
                if urls.is_empty() {
                    eprintln!("[library] thumb skip {id}: no preview url");
                    return (id, title, Err("no preview url".into()));
                }
                let stem = safe_id(&id);
                let expect_ns = creation_expects_non_square(&creation);
                let mut last_err = String::from("no preview url");
                let n = urls.len();
                for (i, url) in urls.into_iter().enumerate() {
                    let last = i + 1 == n;
                    match download_url_with_ext(&url, "image", &thumbs_dir, &stem).await {
                        Ok(path) => {
                            // Server fits often 200 with square thumb fallback — skip those for
                            // non-square creations until we get a real fit / full image.
                            if expect_ns && image_file_is_square_cdn_thumb(&path) && !last {
                                eprintln!(
                                    "[library] thumb reject square for non-square {id} ({url})"
                                );
                                let _ = tokio::fs::remove_file(&path).await;
                                last_err = "square thumb rejected".into();
                                continue;
                            }
                            return (id, title, Ok(path.display().to_string()));
                        }
                        Err(err) => {
                            eprintln!("[library] thumb try fail {id} ({url}): {err}");
                            last_err = err;
                        }
                    }
                }
                eprintln!("[library] thumb fail {id}: {last_err}");
                (id, title, Err(last_err))
            }
        })
        .buffer_unordered(THUMB_CONCURRENCY);

    let mut downloaded = 0u32;
    let mut done = 0u32;
    let mut failed = 0u32;
    let mut auth_fail_streak = 0u32;
    // Commit + progress as each fetch finishes — never wait for the whole batch.
    while let Some((id, title, result)) = stream.next().await {
        done += 1;
        match result {
            Ok(path_str) => {
                auth_fail_streak = 0;
                {
                    let conn = ready_connection(paths)?;
                    let _ = set_local_thumb_path(&conn, &id, &path_str);
                }
                emit_creation_updated(app, &id);
                thumb_paths.insert(id.clone(), path_str);
                downloaded += 1;
                let _ = app.emit(
                    "library-sync-item",
                    SyncItemEvent {
                        id: id.clone(),
                        title,
                        kind: "thumb".into(),
                        state: "done".into(),
                        detail: None,
                    },
                );
                emit_progress(app, done, total, Some(id), failed, "thumbs");
            }
            Err(err) => {
                failed += 1;
                if is_systemic_download_err(&err) {
                    auth_fail_streak = auth_fail_streak.saturating_add(1);
                } else {
                    auth_fail_streak = 0;
                }
                let _ = app.emit(
                    "library-sync-item",
                    SyncItemEvent {
                        id: id.clone(),
                        title,
                        kind: "thumb".into(),
                        state: "failed".into(),
                        detail: Some(short_download_err(&err)),
                    },
                );
                emit_progress(app, done, total, Some(id), failed, "thumbs");
                // Drop the rest of the concurrent stream — further GETs will fail the same way.
                if media_fail_should_abort(auth_fail_streak, &err) {
                    eprintln!(
                        "[library] thumb batch abort after {auth_fail_streak} systemic failures · {}",
                        short_download_err(&err)
                    );
                    break;
                }
            }
        }
    }
    eprintln!("[library] thumb batch done: {downloaded}/{total} ok, {failed} failed");
    Ok((downloaded, thumb_paths))
}

async fn download_batch(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    pending: Vec<Creation>,
) -> Result<DownloadSummary, String> {
    let pending = newest_first(pending);
    let total = (pending.len() * 2) as u32;
    let mut downloaded = 0u32;
    let mut failed = 0u32;
    let mut skipped = 0u32;
    let mut done = pending.len() as u32;

    if total == 0 {
        return Ok(DownloadSummary {
            downloaded: 0,
            failed: 0,
            skipped: 0,
            status: sync_status_for(paths)?,
        });
    }

    let (_, thumb_paths) = download_thumbs_only(app, paths, pending.clone()).await?;
    emit_sync_items(app, &pending, "media", "queued");

    let mut fail_streak = 0u32;
    let mut pending_iter = pending.into_iter();
    while let Some(creation) = pending_iter.next() {
        emit_progress(app, done, total, Some(creation.id.clone()), failed, "media");
        emit_sync_item(app, &creation, "media", "active");

        let Some(remote) = creation.remote_url.as_deref().filter(|u| !u.is_empty()) else {
            skipped += 1;
            done += 1;
            emit_sync_item_detail(
                app,
                &creation,
                "media",
                "skipped",
                Some("no remote url".into()),
            );
            continue;
        };

        {
            let conn = ready_connection(paths)?;
            let _ = set_download_state(&conn, &creation.id, "downloading");
        }

        let stem = safe_id(&creation.id);
        match download_media_file(remote, &creation.media_type, &paths.media, &stem).await {
            Ok(media_path) => {
                fail_streak = 0;
                let thumb = thumb_paths.get(&creation.id).cloned().or_else(|| {
                    if creation.media_type == "image" {
                        Some(media_path.display().to_string())
                    } else {
                        None
                    }
                });
                {
                    let conn = ready_connection(paths)?;
                    mark_downloaded(
                        &conn,
                        &creation.id,
                        &media_path.display().to_string(),
                        thumb.as_deref(),
                    )?;
                }
                emit_creation_updated(app, &creation.id);
                emit_sync_item(app, &creation, "media", "done");
                downloaded += 1;
            }
            Err(err) => {
                fail_streak = fail_streak.saturating_add(1);
                // Media miss is retryable. Don't paint the board as hard-failed when
                // a local thumb already exists (or can still be fetched later).
                let has_preview = creation
                    .local_thumb_path
                    .as_ref()
                    .map(|p| Path::new(p).is_file())
                    .unwrap_or(false)
                    || thumb_paths.contains_key(&creation.id);
                {
                    let conn = ready_connection(paths)?;
                    let _ = set_download_state(
                        &conn,
                        &creation.id,
                        if has_preview { "remote" } else { "failed" },
                    );
                }
                emit_creation_updated(app, &creation.id);
                emit_sync_item_detail(
                    app,
                    &creation,
                    "media",
                    "failed",
                    Some(short_download_err(&err)),
                );
                failed += 1;
                if media_fail_should_abort(fail_streak, &err) {
                    let reason = format!(
                        "stopped after {fail_streak} failures · {}",
                        short_download_err(&err)
                    );
                    eprintln!("[library] media queue abort: {reason}");
                    skip_remaining_media(app, pending_iter, &reason, &mut skipped);
                    break;
                }
            }
        }
        done += 1;
        emit_progress(app, done, total, Some(creation.id.clone()), failed, "media");
    }

    emit_progress(app, total, total, None, failed, "media");

    Ok(DownloadSummary {
        downloaded,
        failed,
        skipped,
        status: sync_status_for(paths)?,
    })
}

/// Full media only (thumbs are a separate higher-priority queue).
async fn download_media_only(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    creation: Creation,
) -> Result<(), String> {
    if !needs_download(&creation) {
        return Ok(());
    }
    let Some(remote) = creation.remote_url.as_deref().filter(|u| !u.is_empty()) else {
        return Ok(());
    };

    emit_progress(app, 0, 1, Some(creation.id.clone()), 0, "media");
    emit_sync_item(app, &creation, "media", "active");
    {
        let conn = ready_connection(paths)?;
        if creation.download_state == "failed" {
            let _ = set_download_state(&conn, &creation.id, "queued");
            emit_creation_updated(app, &creation.id);
        }
        let _ = set_download_state(&conn, &creation.id, "downloading");
    }

    let stem = safe_id(&creation.id);
    match download_media_file(remote, &creation.media_type, &paths.media, &stem).await {
        Ok(media_path) => {
            let thumb = if creation.media_type == "image"
                && creation
                    .local_thumb_path
                    .as_ref()
                    .map(|p| !Path::new(p).is_file())
                    .unwrap_or(true)
            {
                Some(media_path.display().to_string())
            } else {
                None
            };
            {
                let conn = ready_connection(paths)?;
                mark_downloaded(
                    &conn,
                    &creation.id,
                    &media_path.display().to_string(),
                    thumb.as_deref(),
                )?;
            }
            emit_creation_updated(app, &creation.id);
            emit_sync_item(app, &creation, "media", "done");
            emit_progress(app, 1, 1, Some(creation.id.clone()), 0, "media");
            Ok(())
        }
        Err(err) => {
            let has_preview = creation
                .local_thumb_path
                .as_ref()
                .map(|p| Path::new(p).is_file())
                .unwrap_or(false);
            {
                let conn = ready_connection(paths)?;
                let _ = set_download_state(
                    &conn,
                    &creation.id,
                    if has_preview { "remote" } else { "failed" },
                );
            }
            emit_creation_updated(app, &creation.id);
            emit_sync_item_detail(
                app,
                &creation,
                "media",
                "failed",
                Some(short_download_err(&err)),
            );
            emit_progress(app, 1, 1, Some(creation.id.clone()), 1, "media");
            Err(err)
        }
    }
}

/// Full-media batch for Sync-page "cache all" — one running done/total.
async fn download_media_batch(
    app: &AppHandle,
    paths: &super::paths::ParascenePaths,
    pending: Vec<Creation>,
) -> Result<DownloadSummary, String> {
    let pending = newest_first(pending);
    let total = pending.len() as u32;
    let mut downloaded = 0u32;
    let mut failed = 0u32;
    let mut skipped = 0u32;

    if total == 0 {
        return Ok(DownloadSummary {
            downloaded: 0,
            failed: 0,
            skipped: 0,
            status: sync_status_for(paths)?,
        });
    }

    emit_progress(app, 0, total, None, 0, "media");
    emit_sync_items(app, &pending, "media", "queued");
    let mut fail_streak = 0u32;
    let mut pending_iter = pending.into_iter().enumerate();
    while let Some((i, creation)) = pending_iter.next() {
        let done = i as u32;
        emit_progress(app, done, total, Some(creation.id.clone()), failed, "media");
        emit_sync_item(app, &creation, "media", "active");

        if !needs_download(&creation) {
            skipped += 1;
            fail_streak = 0;
            emit_sync_item(app, &creation, "media", "done");
            emit_progress(
                app,
                done + 1,
                total,
                Some(creation.id.clone()),
                failed,
                "media",
            );
            continue;
        }
        let Some(remote) = creation.remote_url.as_deref().filter(|u| !u.is_empty()) else {
            skipped += 1;
            emit_sync_item_detail(
                app,
                &creation,
                "media",
                "skipped",
                Some("no remote url".into()),
            );
            emit_progress(
                app,
                done + 1,
                total,
                Some(creation.id.clone()),
                failed,
                "media",
            );
            continue;
        };

        {
            let conn = ready_connection(paths)?;
            if creation.download_state == "failed" {
                let _ = set_download_state(&conn, &creation.id, "queued");
                emit_creation_updated(app, &creation.id);
            }
            let _ = set_download_state(&conn, &creation.id, "downloading");
        }

        let stem = safe_id(&creation.id);
        match download_media_file(remote, &creation.media_type, &paths.media, &stem).await {
            Ok(media_path) => {
                fail_streak = 0;
                let thumb = if creation.media_type == "image"
                    && creation
                        .local_thumb_path
                        .as_ref()
                        .map(|p| !Path::new(p).is_file())
                        .unwrap_or(true)
                {
                    Some(media_path.display().to_string())
                } else {
                    None
                };
                {
                    let conn = ready_connection(paths)?;
                    mark_downloaded(
                        &conn,
                        &creation.id,
                        &media_path.display().to_string(),
                        thumb.as_deref(),
                    )?;
                }
                emit_creation_updated(app, &creation.id);
                emit_sync_item(app, &creation, "media", "done");
                downloaded += 1;
            }
            Err(err) => {
                fail_streak = fail_streak.saturating_add(1);
                let has_preview = creation
                    .local_thumb_path
                    .as_ref()
                    .map(|p| Path::new(p).is_file())
                    .unwrap_or(false);
                {
                    let conn = ready_connection(paths)?;
                    let _ = set_download_state(
                        &conn,
                        &creation.id,
                        if has_preview { "remote" } else { "failed" },
                    );
                }
                emit_creation_updated(app, &creation.id);
                emit_sync_item_detail(
                    app,
                    &creation,
                    "media",
                    "failed",
                    Some(short_download_err(&err)),
                );
                failed += 1;
                if media_fail_should_abort(fail_streak, &err) {
                    let reason = format!(
                        "stopped after {fail_streak} failures · {}",
                        short_download_err(&err)
                    );
                    eprintln!("[library] media queue abort: {reason}");
                    skip_remaining_media(app, pending_iter.map(|(_, c)| c), &reason, &mut skipped);
                    break;
                }
            }
        }
        emit_progress(
            app,
            done + 1,
            total,
            Some(creation.id.clone()),
            failed,
            "media",
        );
    }
    emit_progress(app, total, total, None, failed, "media");

    Ok(DownloadSummary {
        downloaded,
        failed,
        skipped,
        status: sync_status_for(paths)?,
    })
}

/// Prefer the high lane; only touch low when high is empty so visible bumps win.
fn take_thumb_batch(q: &mut EnsureQueue) -> Vec<String> {
    let mut ids = Vec::new();
    while let Some(id) = q.thumbs_high.pop_front() {
        q.thumbs_queued.remove(&id);
        ids.push(id);
    }
    if !ids.is_empty() {
        return ids;
    }
    while let Some(id) = q.thumbs_low.pop_front() {
        q.thumbs_queued.remove(&id);
        ids.push(id);
    }
    ids
}

fn take_next_urgent_media(q: &mut EnsureQueue) -> Option<String> {
    let id = q.media_urgent.pop_front()?;
    q.media_queued.remove(&id);
    Some(id)
}

fn take_next_media(q: &mut EnsureQueue) -> Option<String> {
    let id = q
        .media_high
        .pop_front()
        .or_else(|| q.media_low.pop_front())?;
    q.media_queued.remove(&id);
    Some(id)
}

fn queue_has_work(q: &EnsureQueue) -> bool {
    !q.media_urgent.is_empty()
        || !q.thumbs_high.is_empty()
        || !q.thumbs_low.is_empty()
        || !q.media_high.is_empty()
        || !q.media_low.is_empty()
}

async fn run_media_job(app: &AppHandle, id: &str) -> Result<(), String> {
    let Ok(paths) = default_paths() else {
        return Err("paths unavailable".into());
    };
    let creation = {
        let Ok(conn) = ready_connection(&paths) else {
            return Err("catalog unavailable".into());
        };
        get_creation_by_id(&conn, id).ok().flatten()
    };
    match creation {
        Some(creation) => download_media_only(app, &paths, creation).await,
        None => Ok(()),
    }
}

fn clear_non_urgent_media_queue(app: &AppHandle, reason: &str) {
    let drained: Vec<String> = {
        let Ok(mut q) = ensure_queue().lock() else {
            return;
        };
        let mut ids = Vec::new();
        while let Some(id) = q.media_high.pop_front() {
            q.media_queued.remove(&id);
            ids.push(id);
        }
        while let Some(id) = q.media_low.pop_front() {
            q.media_queued.remove(&id);
            ids.push(id);
        }
        ids
    };
    if drained.is_empty() {
        return;
    }
    eprintln!(
        "[library] cleared {} queued media jobs — {reason}",
        drained.len()
    );
    if let Ok(paths) = default_paths() {
        if let Ok(conn) = ready_connection(&paths) {
            if let Ok(creations) = get_creations_by_ids(&conn, &drained) {
                let mut skipped = 0u32;
                skip_remaining_media(app, creations, reason, &mut skipped);
            }
        }
    }
}

fn start_ensure_worker(app: AppHandle) {
    let mut start = false;
    if let Ok(mut q) = ensure_queue().lock() {
        if !q.running {
            q.running = true;
            start = true;
        }
    }
    if start {
        tauri::async_runtime::spawn(async move {
            ensure_worker(app).await;
        });
    }
}

fn enqueue_thumbs(app: AppHandle, ids: Vec<String>, priority: bool) {
    if ids.is_empty() {
        return;
    }
    if let Ok(mut q) = ensure_queue().lock() {
        for id in ids {
            q.enqueue_thumb(id, priority);
        }
    }
    start_ensure_worker(app);
}

fn enqueue_media(app: AppHandle, ids: Vec<String>, priority: bool) {
    if ids.is_empty() {
        return;
    }
    if let Ok(mut q) = ensure_queue().lock() {
        for id in ids {
            q.enqueue_media(id, priority);
        }
    }
    start_ensure_worker(app);
}

fn enqueue_media_urgent(app: AppHandle, ids: Vec<String>) {
    if ids.is_empty() {
        return;
    }
    if let Ok(mut q) = ensure_queue().lock() {
        for id in ids {
            q.enqueue_media_urgent(id);
        }
    }
    start_ensure_worker(app);
}

async fn ensure_worker(app: AppHandle) {
    let mut media_fail_streak = 0u32;
    loop {
        // 1) Lightbox click — utmost priority, ahead of all thumb warm work.
        let urgent_id = {
            let Ok(mut q) = ensure_queue().lock() else {
                return;
            };
            take_next_urgent_media(&mut q)
        };
        if let Some(id) = urgent_id {
            match run_media_job(&app, &id).await {
                Ok(()) => media_fail_streak = 0,
                Err(err) => {
                    media_fail_streak = media_fail_streak.saturating_add(1);
                    if media_fail_should_abort(media_fail_streak, &err) {
                        let reason = format!(
                            "stopped after {media_fail_streak} failures · {}",
                            short_download_err(&err)
                        );
                        clear_non_urgent_media_queue(&app, &reason);
                        media_fail_streak = 0;
                    }
                }
            }
            continue;
        }

        // 2) Board thumbs.
        let thumb_ids = {
            let Ok(mut q) = ensure_queue().lock() else {
                return;
            };
            take_thumb_batch(&mut q)
        };
        if !thumb_ids.is_empty() {
            // If a lightbox click arrives mid-thumb-prep, bail to urgent next loop.
            let paths = match default_paths() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let pending = {
                let Ok(conn) = ready_connection(&paths) else {
                    continue;
                };
                get_creations_by_ids(&conn, &thumb_ids)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|c| {
                        if c.download_state == "failed" {
                            let _ = set_download_state(&conn, &c.id, "queued");
                            emit_creation_updated(&app, &c.id);
                        }
                        needs_thumb(c)
                    })
                    .collect::<Vec<_>>()
            };
            if !pending.is_empty() {
                let _ = download_thumbs_only(&app, &paths, pending).await;
            }
            continue;
        }

        // 3) Background / non-urgent media.
        let media_id = {
            let Ok(mut q) = ensure_queue().lock() else {
                return;
            };
            take_next_media(&mut q)
        };
        if let Some(id) = media_id {
            let urgent_waiting = ensure_queue()
                .lock()
                .map(|q| !q.media_urgent.is_empty())
                .unwrap_or(false);
            if urgent_waiting {
                enqueue_media(app.clone(), vec![id], true);
                continue;
            }
            match run_media_job(&app, &id).await {
                Ok(()) => media_fail_streak = 0,
                Err(err) => {
                    media_fail_streak = media_fail_streak.saturating_add(1);
                    if media_fail_should_abort(media_fail_streak, &err) {
                        let reason = format!(
                            "stopped after {media_fail_streak} failures · {}",
                            short_download_err(&err)
                        );
                        clear_non_urgent_media_queue(&app, &reason);
                        media_fail_streak = 0;
                    }
                }
            }
            continue;
        }

        let Ok(mut q) = ensure_queue().lock() else {
            return;
        };
        if queue_has_work(&q) {
            continue;
        }
        q.running = false;
        return;
    }
}

/// Priority save-to-local for UI requests.
/// `urgent` (lightbox open) jumps ahead of all thumb warm-cache work.
#[tauri::command]
pub fn library_ensure_local(
    app: AppHandle,
    ids: Vec<String>,
    full_media: bool,
    urgent: Option<bool>,
) -> Result<(), String> {
    let urgent = urgent.unwrap_or(false);
    if urgent && full_media {
        enqueue_media_urgent(app, ids);
        return Ok(());
    }
    enqueue_thumbs(app.clone(), ids.clone(), true);
    if full_media {
        enqueue_media(app, ids, true);
    }
    Ok(())
}

/// Kick high-priority thumb warm-ahead (and low-priority media for the first page).
/// Does not block on downloads — stays ahead of scroll via the ensure queue.
#[tauri::command]
pub async fn library_download_pending(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<DownloadSummary, String> {
    let limit = limit.unwrap_or(40).clamp(1, 200);
    spawn_scroll_ahead(app, limit, 0);
    Ok(DownloadSummary {
        downloaded: 0,
        failed: 0,
        skipped: 0,
        status: sync_status_for(&default_paths()?)?,
    })
}

/// Download specific creations (newest-first among the set). Full media warm-cache.
#[tauri::command]
pub async fn library_download_ids(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<DownloadSummary, String> {
    let paths = default_paths()?;
    let pending = {
        let conn = ready_connection(&paths)?;
        get_creations_by_ids(&conn, &ids)?
            .into_iter()
            .filter(needs_download)
            .collect()
    };
    download_batch(&app, &paths, pending).await
}

/// Prefetch thumbs for catalog rows.
#[tauri::command]
pub async fn library_download_thumbs(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<DownloadSummary, String> {
    let paths = default_paths()?;
    // Explicit ids always re-fetch (caller invalidated / wants refresh). Filter only by
    // having a preview URL so we don't no-op after square→fit repair.
    let pending = {
        let conn = ready_connection(&paths)?;
        get_creations_by_ids(&conn, &ids)?
            .into_iter()
            .filter(|c| preview_url_for(c).is_some())
            .collect()
    };
    let (downloaded, _) = download_thumbs_only(&app, &paths, pending).await?;
    Ok(DownloadSummary {
        downloaded,
        failed: 0,
        skipped: 0,
        status: sync_status_for(&paths)?,
    })
}

/// Clear local previews that are still square CDN thumbs on non-square creations.
#[tauri::command]
pub fn library_invalidate_mismatched_thumbs() -> Result<Vec<String>, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let ids = list_ids_with_mismatched_square_thumbs(&conn)?;
    clear_local_thumb_paths(&conn, &ids)?;
    Ok(ids)
}

/// Inspect the local catalog for fit work: regenerate from media, upload existing, or server-only.
#[tauri::command]
pub fn library_local_fit_plan() -> Result<LocalFitPlan, String> {
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    build_local_fit_plan(&conn)
}

/// Cache every missing local preview (Sync page). Runs in background; progress events fire.
#[tauri::command]
pub fn library_cache_missing_thumbs(app: AppHandle) -> Result<DownloadSummary, String> {
    let paths = default_paths()?;
    let pending: Vec<Creation> = {
        let conn = ready_connection(&paths)?;
        list_creations(&conn)?
            .into_iter()
            .filter(needs_thumb)
            .collect()
    };
    let queued = pending.len() as u32;
    let status = sync_status_for(&paths)?;
    if queued == 0 {
        return Ok(DownloadSummary {
            downloaded: 0,
            failed: 0,
            skipped: 0,
            status,
        });
    }
    emit_progress(&app, 0, queued, None, 0, "thumbs");
    let paths_bg = paths.clone();
    tauri::async_runtime::spawn(async move {
        let _ = download_thumbs_only(&app, &paths_bg, pending).await;
    });
    Ok(DownloadSummary {
        downloaded: 0,
        failed: 0,
        skipped: queued,
        status,
    })
}

/// Cache every missing full media file (Sync page). Runs in background; progress events fire.
#[tauri::command]
pub fn library_cache_missing_media(app: AppHandle) -> Result<DownloadSummary, String> {
    let paths = default_paths()?;
    let pending: Vec<Creation> = {
        let conn = ready_connection(&paths)?;
        list_creations(&conn)?
            .into_iter()
            .filter(needs_download)
            .collect()
    };
    let queued = pending.len() as u32;
    let status = sync_status_for(&paths)?;
    if queued == 0 {
        return Ok(DownloadSummary {
            downloaded: 0,
            failed: 0,
            skipped: 0,
            status,
        });
    }
    emit_progress(&app, 0, queued, None, 0, "media");
    let paths_bg = paths.clone();
    tauri::async_runtime::spawn(async move {
        let _ = download_media_batch(&app, &paths_bg, pending).await;
    });
    Ok(DownloadSummary {
        downloaded: 0,
        failed: 0,
        skipped: queued,
        status,
    })
}

/**
 * Stay ahead of the board: whenever the UI lists a window at `offset`,
 * enqueue thumbs for that window plus several pages beyond it (high priority).
 * Full media for only the immediate page is low priority and never cuts thumbs.
 */
pub(crate) fn spawn_scroll_ahead(app: AppHandle, limit: u32, offset: u32) {
    tauri::async_runtime::spawn(async move {
        let Ok(paths) = default_paths() else {
            return;
        };
        let Ok(conn) = ready_connection(&paths) else {
            return;
        };
        let limit = limit.clamp(1, 200);
        let ahead_count = limit.saturating_mul(THUMB_AHEAD_PAGES).clamp(limit, 960);
        let Ok(warm) = list_creations_page(&conn, ahead_count, offset) else {
            return;
        };

        let thumb_ids: Vec<String> = warm
            .creations
            .iter()
            .filter(|c| needs_thumb(c))
            .map(|c| c.id.clone())
            .collect();
        // High priority — scrolling should not catch a cold thumb frontier.
        enqueue_thumbs(app.clone(), thumb_ids, true);

        let media_ids: Vec<String> = warm
            .creations
            .iter()
            .take(limit as usize)
            .filter(|c| needs_download(c))
            .map(|c| c.id.clone())
            .collect();
        enqueue_media(app, media_ids, false);
    });
}

/// Delete one creation from the local catalog and its on-disk files (not cloud).
#[tauri::command]
pub fn library_delete_local(app: AppHandle, id: String) -> Result<SyncStatus, String> {
    let paths = default_paths()?;
    {
        let conn = ready_connection(&paths)?;
        delete_creation_local(&conn, &paths, &id)?;
    }
    let _ = app.emit("library-creation-deleted", id);
    sync_status_for(&paths)
}
