use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug)]
pub struct ParascenePaths {
    pub root: PathBuf,
    pub library: PathBuf,
    pub media: PathBuf,
    pub thumbs: PathBuf,
    pub projects: PathBuf,
    pub exports: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub catalog_db: PathBuf,
}

/// Machine plane: `~/Movies/Parascene/` (accounts.json, live session, `users/`).
pub fn machine_root() -> Result<PathBuf, String> {
    let movies = dirs::video_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve home/Movies directory".to_string())?;
    Ok(movies.join("Parascene"))
}

fn current_account() -> &'static Mutex<Option<PathBuf>> {
    static CURRENT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

/// Process account root. `None` until login/restore binds an account.
pub fn set_account_root(root: Option<PathBuf>) {
    if let Ok(mut guard) = current_account().lock() {
        *guard = root;
    }
}

pub fn account_root() -> Result<PathBuf, String> {
    let guard = current_account()
        .lock()
        .map_err(|_| "Account root lock poisoned".to_string())?;
    guard.clone().ok_or_else(|| "No account is bound".to_string())
}

#[allow(dead_code)]
pub fn account_root_if_set() -> Option<PathBuf> {
    current_account()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub fn resolve_paths(root: PathBuf) -> ParascenePaths {
    let library = root.join("Library");
    ParascenePaths {
        catalog_db: library.join("catalog.sqlite"),
        media: library.join("media"),
        thumbs: library.join("thumbs"),
        logs: library.join("logs"),
        library,
        projects: root.join("Projects"),
        exports: root.join("Exports"),
        cache: root.join("Cache"),
        root,
    }
}

pub fn ensure_directories(paths: &ParascenePaths) -> Result<(), String> {
    for dir in [
        &paths.root,
        &paths.library,
        &paths.media,
        &paths.thumbs,
        &paths.projects,
        &paths.exports,
        &paths.cache,
        &paths.logs,
    ] {
        fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn ensure_directories_creates_layout() {
        let root = env::temp_dir().join(format!("parascene-paths-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let paths = resolve_paths(root.clone());
        ensure_directories(&paths).expect("dirs");
        assert!(paths.library.is_dir());
        assert!(paths.media.is_dir());
        assert!(paths.thumbs.is_dir());
        assert!(paths.projects.is_dir());
        assert!(paths.exports.is_dir());
        assert!(paths.cache.is_dir());
        assert!(paths.logs.is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn account_root_requires_bind() {
        set_account_root(None);
        assert!(account_root().is_err());
        let tmp = env::temp_dir().join(format!("parascene-bind-{}", std::process::id()));
        set_account_root(Some(tmp.clone()));
        assert_eq!(account_root().unwrap(), tmp);
        set_account_root(None);
    }
}
