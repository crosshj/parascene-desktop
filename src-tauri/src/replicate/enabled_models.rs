//! Persisted allowlist of models that may open a run UI.
//! Stored under Cache/replicate/enabled-models.json — edited via Lab UI / Tauri commands.

use crate::library::paths::{default_root, ensure_directories, resolve_paths};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct EnabledFile {
    /// `"owner/name"` keys.
    models: Vec<String>,
}

fn store() -> &'static Mutex<Option<BTreeSet<String>>> {
    static STORE: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
    &STORE
}

fn enabled_path() -> Result<std::path::PathBuf, String> {
    let root = default_root()?;
    let paths = resolve_paths(root);
    ensure_directories(&paths)?;
    let dir = paths.cache.join("replicate");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir.join("enabled-models.json"))
}

fn load_from_disk() -> Result<BTreeSet<String>, String> {
    let path = enabled_path()?;
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: EnabledFile = serde_json::from_str(&raw).unwrap_or_default();
    Ok(parsed.models.into_iter().collect())
}

fn save_to_disk(set: &BTreeSet<String>) -> Result<(), String> {
    let path = enabled_path()?;
    let payload = EnabledFile {
        models: set.iter().cloned().collect(),
    };
    let raw = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw).map_err(|e| format!("Write enabled list failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Commit enabled list failed: {e}"))?;
    Ok(())
}

fn with_set<R>(f: impl FnOnce(&mut BTreeSet<String>) -> Result<R, String>) -> Result<R, String> {
    let mut guard = store()
        .lock()
        .map_err(|_| "enabled models lock poisoned".to_string())?;
    if guard.is_none() {
        *guard = Some(load_from_disk()?);
    }
    let set = guard.as_mut().expect("just initialized");
    f(set)
}

pub fn model_key(owner: &str, name: &str) -> String {
    format!("{owner}/{name}")
}

pub fn is_enabled(owner: &str, name: &str) -> bool {
    let key = model_key(owner, name);
    with_set(|set| Ok(set.contains(&key))).unwrap_or(false)
}

pub fn list_enabled() -> Result<Vec<String>, String> {
    with_set(|set| Ok(set.iter().cloned().collect()))
}

pub fn set_enabled(owner: &str, name: &str, enabled: bool) -> Result<bool, String> {
    let owner = owner.trim();
    let name = name.trim();
    if owner.is_empty() || name.is_empty() {
        return Err("owner and name are required".into());
    }
    if owner.contains('/') || name.contains('/') {
        return Err("invalid owner/name".into());
    }
    let key = model_key(owner, name);
    with_set(|set| {
        if enabled {
            set.insert(key);
        } else {
            set.remove(&key);
        }
        save_to_disk(set)?;
        Ok(enabled)
    })
}
