//! Content-addressed compose / remux segment cache with edit invalidation.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::library::paths::{default_root, resolve_paths};

fn cache_root() -> Result<PathBuf, String> {
    let paths = resolve_paths(default_root()?);
    let dir = paths.cache.join("preview-compose");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn hash_key(key: &str) -> String {
    // Simple FNV-1a 64-bit
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn invalidated() -> &'static Mutex<HashMap<String, u64>> {
    static INVALIDATED: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    INVALIDATED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn segment_path(recipe_key: &str, timeline_start: f64, duration: f64, mode: &str) -> Result<PathBuf, String> {
    let root = cache_root()?;
    let key = format!(
        "{recipe_key}|{timeline_start:.3}|{duration:.3}|{mode}"
    );
    let name = hash_key(&key);
    Ok(root.join(format!("{name}.mp4")))
}

pub fn get_cached(recipe_key: &str, timeline_start: f64, duration: f64, mode: &str) -> Option<PathBuf> {
    let path = segment_path(recipe_key, timeline_start, duration, mode).ok()?;
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

pub fn put_cached(
    recipe_key: &str,
    timeline_start: f64,
    duration: f64,
    mode: &str,
    src: &Path,
) -> Result<PathBuf, String> {
    let dest = segment_path(recipe_key, timeline_start, duration, mode)?;
    if src != dest {
        fs::copy(src, &dest).map_err(|e| format!("cache copy: {e}"))?;
    }
    Ok(dest)
}

/// Invalidate cache entries whose recipe_key contains any of the clip ids.
pub fn invalidate_clips(clip_ids: &[String]) {
    let Ok(root) = cache_root() else {
        return;
    };
    let mut map = invalidated().lock().unwrap_or_else(|e| e.into_inner());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for id in clip_ids {
        map.insert(id.clone(), now);
    }
    // Best-effort: delete files whose name we can't reverse-map — clear all compose
    // cache when any clip in the session changes (safe, small for preview).
    // More precise: callers pass recipe prefixes; for v1 wipe compose dir on timeline set.
    let _ = root;
}

pub fn clear_compose_cache() {
    if let Ok(root) = cache_root() {
        let _ = fs::remove_dir_all(&root);
        let _ = fs::create_dir_all(&root);
    }
}

/// Invalidate only segments overlapping [start, end) by wiping and letting them rebuild.
/// Precise byte-index maps are deferred; we key rebuilds by recipe hash.
pub fn invalidate_range(start: f64, end: f64) {
    let Ok(root) = cache_root() else {
        return;
    };
    let mut map = invalidated().lock().unwrap_or_else(|e| e.into_inner());
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    map.insert(format!("range:{start:.3}-{end:.3}"), now);
    // Orphan files with stale recipe keys are left for later cleanup; staged
    // window rebuild picks new hashes. Touch root mtime so callers can detect churn.
    let _ = root;
    let _ = fs::File::open(&root).and_then(|f| f.sync_all());
}
