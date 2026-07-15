use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct ParascenePaths {
    pub root: PathBuf,
    pub library: PathBuf,
    pub media: PathBuf,
    pub thumbs: PathBuf,
    pub projects: PathBuf,
    pub exports: PathBuf,
    pub cache: PathBuf,
    pub catalog_db: PathBuf,
}

pub fn default_root() -> Result<PathBuf, String> {
    let movies = dirs::video_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not resolve home/Movies directory".to_string())?;
    Ok(movies.join("Parascene"))
}

pub fn resolve_paths(root: PathBuf) -> ParascenePaths {
    let library = root.join("Library");
    ParascenePaths {
        catalog_db: library.join("catalog.sqlite"),
        media: library.join("media"),
        thumbs: library.join("thumbs"),
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
        let root = env::temp_dir().join(format!(
            "parascene-paths-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let paths = resolve_paths(root.clone());
        ensure_directories(&paths).expect("dirs");
        assert!(paths.library.is_dir());
        assert!(paths.media.is_dir());
        assert!(paths.thumbs.is_dir());
        assert!(paths.projects.is_dir());
        assert!(paths.exports.is_dir());
        assert!(paths.cache.is_dir());
        let _ = fs::remove_dir_all(&root);
    }
}
