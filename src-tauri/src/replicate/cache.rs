use crate::library::paths::{default_root, ensure_directories, resolve_paths};
use crate::replicate::enabled_models::is_enabled;
use crate::replicate::features::{features_from_model, input_summary, InputFieldSummary};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn replicate_dir() -> Result<PathBuf, String> {
    let root = default_root()?;
    let paths = resolve_paths(root);
    ensure_directories(&paths)?;
    let dir = paths.cache.join("replicate");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    std::fs::create_dir_all(dir.join("models"))
        .map_err(|e| format!("Could not create models cache: {e}"))?;
    Ok(dir)
}

fn meta_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}
fn index_path(dir: &Path) -> PathBuf {
    dir.join("models-index.json")
}
fn checkpoint_path(dir: &Path) -> PathBuf {
    dir.join("crawl-checkpoint.json")
}
fn model_file(dir: &Path, owner: &str, name: &str) -> PathBuf {
    let safe = format!("{owner}__{name}.json");
    dir.join("models").join(safe)
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path".to_string())?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("tmp")
    ));
    std::fs::write(&tmp, contents).map_err(|e| format!("Write failed: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Rename failed: {e}"))?;
    Ok(())
}

fn read_json_file(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMeta {
    pub last_full_sync_at: Option<u64>,
    pub last_incremental_at: Option<u64>,
    pub newest_seen_version_at: Option<String>,
    pub newest_seen_created_at: Option<String>,
    pub model_count: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CrawlStatus {
    Idle,
    Running,
    Paused,
}

impl Default for CrawlStatus {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CrawlCheckpoint {
    pub status: CrawlStatus,
    pub phase: String,
    pub next_url: Option<String>,
    pub pages_done: u64,
    pub models_merged: u64,
    pub started_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub last_error: Option<String>,
    /// When true, UI may offer Resume (paused or interrupted running).
    pub resumable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIndexRow {
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub run_count: u64,
    pub cover_image_url: Option<String>,
    pub latest_version_id: Option<String>,
    pub latest_version_created_at: Option<String>,
    pub model_created_at: Option<String>,
    pub features: Vec<String>,
    pub schema_cached: bool,
    pub url: Option<String>,
}

impl ModelIndexRow {
    pub fn key(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListRow {
    #[serde(flatten)]
    pub row: ModelIndexRow,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListPage {
    pub rows: Vec<ModelListRow>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
    /// Wall-clock ms for this list call (index load / sort / page). For Lab status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing_ms: Option<ListTimingMs>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTimingMs {
    pub total: u64,
    pub index_load: u64,
    pub sort: u64,
    pub cache_hit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDetailDto {
    pub owner: String,
    pub name: String,
    pub description: Option<String>,
    pub run_count: u64,
    pub cover_image_url: Option<String>,
    pub latest_version_id: Option<String>,
    pub features: Vec<String>,
    pub schema_cached: bool,
    pub enabled: bool,
    pub inputs: Vec<InputFieldSummary>,
    pub url: Option<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub model_count: u64,
    pub meta: CatalogMeta,
    pub checkpoint: CrawlCheckpoint,
    pub token_configured: bool,
    pub crawl_running: bool,
}

pub fn load_meta(dir: &Path) -> CatalogMeta {
    read_json_file(&meta_path(dir))
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_meta(dir: &Path, meta: &CatalogMeta) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    atomic_write(&meta_path(dir), &raw)
}

pub fn load_checkpoint(dir: &Path) -> CrawlCheckpoint {
    let mut cp: CrawlCheckpoint = read_json_file(&checkpoint_path(dir))
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    // Process died mid-run → treat as paused/resumable.
    if cp.status == CrawlStatus::Running {
        cp.status = CrawlStatus::Paused;
        cp.resumable = cp.next_url.is_some();
        cp.phase = "interrupted".into();
        let _ = save_checkpoint(dir, &cp);
    }
    cp
}

pub fn save_checkpoint(dir: &Path, cp: &CrawlCheckpoint) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(cp).map_err(|e| e.to_string())?;
    atomic_write(&checkpoint_path(dir), &raw)
}

pub fn load_index_map(dir: &Path) -> Result<HashMap<String, ModelIndexRow>, String> {
    let (guard, _, _) = cached_index(dir)?;
    let cache = guard
        .as_ref()
        .ok_or_else(|| "Index cache missing after load".to_string())?;
    Ok(cache.map.clone())
}

struct IndexMemCache {
    /// Absolute path of the index file this cache was built from.
    path: PathBuf,
    map: HashMap<String, ModelIndexRow>,
    /// Lazily filled sorted snapshots keyed by sort id.
    sorted: HashMap<String, Vec<ModelIndexRow>>,
}

fn index_mem() -> &'static Mutex<Option<IndexMemCache>> {
    static CACHE: OnceLock<Mutex<Option<IndexMemCache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Deserialize)]
struct IndexFile {
    #[serde(default)]
    models: Vec<ModelIndexRow>,
}

fn read_index_rows(dir: &Path) -> Result<Vec<ModelIndexRow>, String> {
    let path = index_path(dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Direct typed deserialize — avoid Value DOM + clone + second pass on ~6MB.
    match serde_json::from_str::<IndexFile>(&raw) {
        Ok(file) => Ok(file.models),
        Err(_) => {
            // Legacy: bare array.
            match serde_json::from_str::<Vec<ModelIndexRow>>(&raw) {
                Ok(rows) => Ok(rows),
                Err(e) => Err(format!("Could not parse models-index.json: {e}")),
            }
        }
    }
}

fn ensure_sorted(cache: &mut IndexMemCache, sort_key: &str) -> u64 {
    if cache.sorted.contains_key(sort_key) {
        return 0;
    }
    let t0 = std::time::Instant::now();
    let mut rows: Vec<ModelIndexRow> = cache.map.values().cloned().collect();
    sort_rows(&mut rows, sort_key);
    cache.sorted.insert(sort_key.to_string(), rows);
    t0.elapsed().as_millis() as u64
}

fn cached_index(
    dir: &Path,
) -> Result<(std::sync::MutexGuard<'static, Option<IndexMemCache>>, u64, bool), String> {
    let path = index_path(dir);
    let mut guard = index_mem()
        .lock()
        .map_err(|_| "Index cache lock poisoned".to_string())?;
    let needs_load = match guard.as_ref() {
        Some(c) => c.path != path,
        None => true,
    };
    let mut load_ms = 0u64;
    if needs_load {
        let t0 = std::time::Instant::now();
        let rows = read_index_rows(dir)?;
        let map: HashMap<String, ModelIndexRow> =
            rows.into_iter().map(|r| (r.key(), r)).collect();
        let mut cache = IndexMemCache {
            path,
            map,
            sorted: HashMap::new(),
        };
        // Default Lab sort — pay once on cold load, not on first page request.
        ensure_sorted(&mut cache, "runs_desc");
        load_ms = t0.elapsed().as_millis() as u64;
        eprintln!(
            "[replicate] index cold load: {load_ms}ms · {} models",
            cache.map.len()
        );
        *guard = Some(cache);
    }
    Ok((guard, load_ms, !needs_load))
}

fn sort_rows(rows: &mut [ModelIndexRow], sort_key: &str) {
    match sort_key {
        "runs_asc" => rows.sort_by(|a, b| {
            a.run_count
                .cmp(&b.run_count)
                .then_with(|| a.key().cmp(&b.key()))
        }),
        "owner_asc" => rows.sort_by(|a, b| {
            a.owner
                .to_lowercase()
                .cmp(&b.owner.to_lowercase())
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        }),
        "owner_desc" => rows.sort_by(|a, b| {
            b.owner
                .to_lowercase()
                .cmp(&a.owner.to_lowercase())
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        }),
        "name_asc" => rows.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.owner.to_lowercase().cmp(&b.owner.to_lowercase()))
        }),
        "name_desc" => rows.sort_by(|a, b| {
            b.name
                .to_lowercase()
                .cmp(&a.name.to_lowercase())
                .then_with(|| a.owner.to_lowercase().cmp(&b.owner.to_lowercase()))
        }),
        "owner_name_asc" => rows.sort_by(|a, b| a.key().to_lowercase().cmp(&b.key().to_lowercase())),
        // default: runs_desc
        _ => rows.sort_by(|a, b| {
            b.run_count
                .cmp(&a.run_count)
                .then_with(|| a.key().cmp(&b.key()))
        }),
    }
}

pub fn save_index_map(dir: &Path, map: &HashMap<String, ModelIndexRow>) -> Result<(), String> {
    let mut rows: Vec<&ModelIndexRow> = map.values().collect();
    rows.sort_by(|a, b| {
        b.run_count
            .cmp(&a.run_count)
            .then_with(|| a.key().cmp(&b.key()))
    });
    let payload = json!({
        "version": 1,
        "updatedAt": now_ms(),
        "models": rows,
    });
    let raw = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    atomic_write(&index_path(dir), &raw)?;
    // Refresh memory cache from the map we just wrote (avoid re-parse).
    let path = index_path(dir);
    let owned: HashMap<String, ModelIndexRow> = map.clone();
    if let Ok(mut guard) = index_mem().lock() {
        let mut cache = IndexMemCache {
            path,
            map: owned,
            sorted: HashMap::new(),
        };
        ensure_sorted(&mut cache, "runs_desc");
        *guard = Some(cache);
    }
    Ok(())
}

pub fn row_from_api_model(dir: &Path, model: &Value) -> Option<ModelIndexRow> {
    let owner = model.get("owner")?.as_str()?.to_string();
    let name = model.get("name")?.as_str()?.to_string();
    let latest = model.get("latest_version");
    let latest_version_id = latest
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let latest_version_created_at = latest
        .and_then(|v| v.get("created_at"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let schema_cached = model_file(dir, &owner, &name).exists();
    let features = features_from_model(model);
    Some(ModelIndexRow {
        owner,
        name,
        description: model
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        run_count: model
            .get("run_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cover_image_url: model
            .get("cover_image_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        latest_version_id,
        latest_version_created_at,
        model_created_at: None,
        features,
        schema_cached,
        url: model
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

pub fn merge_models_into_index(
    dir: &Path,
    models: &[Value],
) -> Result<(u64, Option<String>), String> {
    let mut map = load_index_map(dir)?;
    let mut newest_version_at: Option<String> = None;
    for m in models {
        if let Some(mut row) = row_from_api_model(dir, m) {
            if let Some(existing) = map.get(&row.key()) {
                // Preserve schema_cached + richer features if detail was fetched.
                if existing.schema_cached {
                    row.schema_cached = true;
                    if existing.features.iter().any(|f| f == "schema") {
                        row.features = existing.features.clone();
                    }
                }
            }
            if let Some(ref ts) = row.latest_version_created_at {
                match &newest_version_at {
                    None => newest_version_at = Some(ts.clone()),
                    Some(cur) if ts > cur => newest_version_at = Some(ts.clone()),
                    _ => {}
                }
            }
            map.insert(row.key(), row);
        }
    }
    save_index_map(dir, &map)?;
    let mut meta = load_meta(dir);
    meta.model_count = map.len() as u64;
    if let Some(ts) = newest_version_at.clone() {
        if meta
            .newest_seen_version_at
            .as_ref()
            .map(|c| &ts > c)
            .unwrap_or(true)
        {
            meta.newest_seen_version_at = Some(ts);
        }
    }
    save_meta(dir, &meta)?;
    Ok((map.len() as u64, newest_version_at))
}

pub fn list_cached(
    query: Option<String>,
    features: Option<Vec<String>>,
    sort: Option<String>,
    offset: u64,
    limit: Option<u64>,
) -> Result<ModelListPage, String> {
    let t_all = std::time::Instant::now();
    let dir = replicate_dir()?;
    let q = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let feat = features.unwrap_or_default();
    let sort_key = sort.as_deref().unwrap_or("runs_desc").to_string();

    let (mut guard, index_load_ms, cache_hit) = cached_index(&dir)?;
    let cache = guard
        .as_mut()
        .ok_or_else(|| "Index cache missing after load".to_string())?;

    // Unfiltered: reuse a cached sorted snapshot and only clone the page slice.
    let (total, page_rows, page_limit, sort_ms) = if q.is_none() && feat.is_empty() {
        let sort_ms = ensure_sorted(cache, &sort_key);
        let sorted = cache
            .sorted
            .get(&sort_key)
            .ok_or_else(|| "Sorted index missing".to_string())?;
        let total = sorted.len() as u64;
        let off = offset as usize;
        let lim = match limit {
            None | Some(0) => sorted.len().saturating_sub(off),
            Some(n) => (n as usize).clamp(1, 100_000),
        };
        let page_rows: Vec<ModelIndexRow> = sorted.iter().skip(off).take(lim).cloned().collect();
        (total, page_rows, lim as u64, sort_ms)
    } else {
        let t_sort = std::time::Instant::now();
        let mut rows: Vec<ModelIndexRow> = cache.map.values().cloned().collect();
        rows.retain(|r| {
            if let Some(ref q) = q {
                let hay = format!(
                    "{}/{} {}",
                    r.owner,
                    r.name,
                    r.description.as_deref().unwrap_or("")
                )
                .to_lowercase();
                if !hay.contains(q) {
                    return false;
                }
            }
            if !feat.is_empty() {
                for f in &feat {
                    if !r.features.iter().any(|x| x == f) {
                        return false;
                    }
                }
            }
            true
        });
        sort_rows(&mut rows, &sort_key);
        let sort_ms = t_sort.elapsed().as_millis() as u64;
        let total = rows.len() as u64;
        let off = offset as usize;
        let lim = match limit {
            None | Some(0) => rows.len().saturating_sub(off),
            Some(n) => (n as usize).clamp(1, 100_000),
        };
        let page_rows = rows.into_iter().skip(off).take(lim).collect();
        (total, page_rows, lim as u64, sort_ms)
    };

    // Drop the lock before touching enabled-models (separate mutex).
    drop(guard);

    let page: Vec<ModelListRow> = page_rows
        .into_iter()
        .map(|row| {
            let enabled = is_enabled(&row.owner, &row.name);
            ModelListRow { row, enabled }
        })
        .collect();
    let total_ms = t_all.elapsed().as_millis() as u64;
    if index_load_ms > 50 || sort_ms > 50 || total_ms > 100 {
        eprintln!(
            "[replicate] list_cached: total={total_ms}ms index_load={index_load_ms}ms sort={sort_ms}ms cache_hit={cache_hit} rows={}",
            page.len()
        );
    }
    Ok(ModelListPage {
        rows: page,
        total,
        offset,
        limit: page_limit,
        timing_ms: Some(ListTimingMs {
            total: total_ms,
            index_load: index_load_ms,
            sort: sort_ms,
            cache_hit,
        }),
    })
}

pub fn get_model_local(owner: &str, name: &str) -> Result<Option<ModelDetailDto>, String> {
    let dir = replicate_dir()?;
    let path = model_file(&dir, owner, name);
    let raw = match read_json_file(&path)? {
        Some(v) => v,
        None => {
            // Fall back to index-only stub.
            let map = load_index_map(&dir)?;
            let key = format!("{owner}/{name}");
            let Some(row) = map.get(&key) else {
                return Ok(None);
            };
            return Ok(Some(ModelDetailDto {
                owner: row.owner.clone(),
                name: row.name.clone(),
                description: row.description.clone(),
                run_count: row.run_count,
                cover_image_url: row.cover_image_url.clone(),
                latest_version_id: row.latest_version_id.clone(),
                features: row.features.clone(),
                schema_cached: false,
                enabled: is_enabled(owner, name),
                inputs: Vec::new(),
                url: row.url.clone(),
                raw: json!({
                    "owner": row.owner,
                    "name": row.name,
                    "description": row.description,
                }),
            }));
        }
    };
    Ok(Some(detail_from_raw(&raw)))
}

fn detail_from_raw(raw: &Value) -> ModelDetailDto {
    let owner = raw
        .get("owner")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let name = raw
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let latest_version_id = raw
        .pointer("/latest_version/id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    ModelDetailDto {
        owner: owner.clone(),
        name: name.clone(),
        description: raw
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        run_count: raw.get("run_count").and_then(|v| v.as_u64()).unwrap_or(0),
        cover_image_url: raw
            .get("cover_image_url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        latest_version_id,
        features: features_from_model(raw),
        schema_cached: true,
        enabled: is_enabled(&owner, &name),
        inputs: input_summary(raw),
        url: raw
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        raw: raw.clone(),
    }
}

pub fn save_model_detail(owner: &str, name: &str, raw: &Value) -> Result<ModelDetailDto, String> {
    let dir = replicate_dir()?;
    let path = model_file(&dir, owner, name);
    let pretty = serde_json::to_string_pretty(raw).map_err(|e| e.to_string())?;
    atomic_write(&path, &pretty)?;

    // Update index row features / schema_cached.
    let mut map = load_index_map(&dir)?;
    let key = format!("{owner}/{name}");
    let dto = detail_from_raw(raw);
    let row = ModelIndexRow {
        owner: dto.owner.clone(),
        name: dto.name.clone(),
        description: dto.description.clone(),
        run_count: dto.run_count,
        cover_image_url: dto.cover_image_url.clone(),
        latest_version_id: dto.latest_version_id.clone(),
        latest_version_created_at: raw
            .pointer("/latest_version/created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        model_created_at: map
            .get(&key)
            .and_then(|r| r.model_created_at.clone()),
        features: dto.features.clone(),
        schema_cached: true,
        url: dto.url.clone(),
    };
    map.insert(key, row);
    save_index_map(&dir, &map)?;
    let mut meta = load_meta(&dir);
    meta.model_count = map.len() as u64;
    save_meta(&dir, &meta)?;
    Ok(dto)
}

pub fn cache_stats(crawl_running: bool) -> Result<CacheStats, String> {
    let dir = replicate_dir()?;
    let meta = load_meta(&dir);
    let checkpoint = load_checkpoint(&dir);
    let token_configured = crate::replicate::token::get_token()?
        .map(|t| !t.is_empty())
        .unwrap_or(false);
    Ok(CacheStats {
        model_count: meta.model_count,
        meta,
        checkpoint,
        token_configured,
        crawl_running,
    })
}

pub fn reset_checkpoint_for_full_crawl(dir: &Path) -> Result<CrawlCheckpoint, String> {
    let cp = CrawlCheckpoint {
        status: CrawlStatus::Running,
        phase: "crawl".into(),
        next_url: Some("https://api.replicate.com/v1/models".into()),
        pages_done: 0,
        models_merged: 0,
        started_at: Some(now_ms()),
        updated_at: Some(now_ms()),
        last_error: None,
        resumable: true,
    };
    save_checkpoint(dir, &cp)?;
    Ok(cp)
}

pub fn now_millis() -> u64 {
    now_ms()
}
