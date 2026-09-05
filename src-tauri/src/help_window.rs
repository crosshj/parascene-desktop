use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub const HELP_WINDOW_LABEL: &str = "help";

const PAGES: &[(&str, &str)] = &[
    ("", "help/index.html"),
    ("index", "help/index.html"),
    ("overview", "help/overview.html"),
    ("screens", "help/overview.html"),
    ("getting-started", "help/getting-started.html"),
    ("start", "help/getting-started.html"),
    ("projects", "help/projects.html"),
    ("create-project", "help/projects.html"),
    ("open-project", "help/projects.html"),
    ("folders", "help/folders.html"),
    ("library", "help/overview.html#library"),
    ("sync", "help/sync.html"),
    ("director", "help/overview.html#director"),
    ("editor", "help/overview.html#editor"),
    ("generate", "help/generate.html"),
    ("generate-image", "help/generate.html"),
    ("tools", "help/tools.html"),
    ("local-tools", "help/tools.html"),
    ("ffmpeg", "help/tools.html"),
    ("demucs", "help/tools.html"),
    ("whisper", "help/tools.html"),
];

pub fn help_page(topic_id: Option<&str>) -> &'static str {
    let key = topic_id.unwrap_or("").trim();
    PAGES
        .iter()
        .find(|(id, _)| *id == key)
        .map(|(_, path)| *path)
        .unwrap_or("help/index.html")
}

fn help_asset_parts(page: &str) -> (String, Option<String>) {
    let page = page.trim().replace('\\', "/");
    let page = page.trim_start_matches('/');
    match page.split_once('#') {
        Some((path, hash)) => (path.to_string(), Some(hash.to_string())),
        None => (page.to_string(), None),
    }
}

fn path_to_file_url(path: &Path, hash: Option<&str>) -> String {
    let mut href = path.to_string_lossy().replace('\\', "/");
    // Windows canonicalize() prefixes \\?\ (and \\?\UNC\). Browsers reject those.
    if let Some(rest) = href.strip_prefix("//?/UNC/") {
        href = format!("//{rest}");
    } else if let Some(rest) = href.strip_prefix("//?/") {
        href = rest.to_string();
    }
    let href = if href.starts_with("//") {
        format!("file:{href}")
    } else if href.starts_with('/') {
        format!("file://{href}")
    } else {
        format!("file:///{href}")
    };
    let href = href.replace(' ', "%20");
    match hash {
        Some(h) if !h.is_empty() => format!("{href}#{h}"),
        _ => href,
    }
}

fn resolve_help_file(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let file = rel.strip_prefix("help/").unwrap_or(rel);
    let mut candidates = Vec::new();
    // Checkout first so `tauri dev` opens the files you edit, not a stale bundle.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../public/help")
            .join(file),
    );
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("help").join(file));
        candidates.push(dir.join("public").join("help").join(file));
    }
    if let Ok(p) = app.path().resolve(format!("help/{file}"), BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("help").join(file));
            candidates.push(dir.join("help").join(file));
        }
    }
    if let Some(found) = candidates.iter().find(|p| p.is_file()) {
        return Ok(std::fs::canonicalize(found).unwrap_or_else(|_| found.clone()));
    }
    Err(format!("Help page not found ({rel})"))
}

fn help_browser_target(app: &AppHandle, page: &str) -> Result<String, String> {
    let (path, hash) = help_asset_parts(page);
    let file = resolve_help_file(app, &path)?;
    Ok(path_to_file_url(&file, hash.as_deref()))
}

fn dismiss_legacy_help_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(HELP_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

pub fn show_help(app: &AppHandle, topic_id: Option<&str>) -> Result<Value, String> {
    let page = help_page(topic_id);
    dismiss_legacy_help_window(app);
    let target = help_browser_target(app, page)?;
    app.opener()
        .open_url(&target, None::<String>)
        .map_err(|e| format!("Could not open Help in the browser: {e}"))?;
    Ok(json!({ "ok": true, "opened": true, "in": "browser", "page": page }))
}

#[tauri::command]
pub fn open_help_window(app: AppHandle, topic_id: Option<String>) -> Result<Value, String> {
    show_help(&app, topic_id.as_deref())
}

#[tauri::command]
pub fn close_help_window(app: AppHandle) -> Result<Value, String> {
    dismiss_legacy_help_window(&app);
    Ok(json!({ "ok": true, "closed": true }))
}

#[cfg(test)]
mod tests {
    use super::{help_asset_parts, help_page, path_to_file_url};
    use std::path::{Path, PathBuf};

    #[test]
    fn maps_known_topics_and_falls_back() {
        assert_eq!(help_page(None), "help/index.html");
        assert_eq!(help_page(Some("overview")), "help/overview.html");
        assert_eq!(help_page(Some("screens")), "help/overview.html");
        assert_eq!(help_page(Some("getting-started")), "help/getting-started.html");
        assert_eq!(help_page(Some("projects")), "help/projects.html");
        assert_eq!(help_page(Some("folders")), "help/folders.html");
        assert_eq!(help_page(Some("sync")), "help/sync.html");
        assert_eq!(help_page(Some("generate")), "help/generate.html");
        assert_eq!(help_page(Some("tools")), "help/tools.html");
        assert_eq!(help_page(Some("ffmpeg")), "help/tools.html");
        assert_eq!(help_page(Some("library")), "help/overview.html#library");
        assert_eq!(help_page(Some("director")), "help/overview.html#director");
        assert_eq!(help_page(Some("nope")), "help/index.html");
    }

    #[test]
    fn help_paths_stay_forward_slash() {
        let (path, hash) = help_asset_parts("help/index.html");
        assert_eq!(path, "help/index.html");
        assert!(hash.is_none());
        assert!(!path.contains('\\'));

        let (path, hash) = help_asset_parts("help\\overview.html#library");
        assert_eq!(path, "help/overview.html");
        assert_eq!(hash.as_deref(), Some("library"));
        assert!(!path.contains('\\'));
    }

    #[test]
    fn checkout_help_lives_on_disk() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/help/index.html");
        assert!(path.is_file(), "{}", path.display());
    }

    #[test]
    fn file_urls_open_in_a_real_browser() {
        let windows = path_to_file_url(Path::new(r"C:\Program Files\Parascene\help\index.html"), None);
        assert_eq!(windows, "file:///C:/Program%20Files/Parascene/help/index.html");

        let hashed = path_to_file_url(Path::new("/tmp/help/overview.html"), Some("library"));
        assert_eq!(hashed, "file:///tmp/help/overview.html#library");

        let verbatim = path_to_file_url(
            Path::new(r"\\?\C:\Program Files\Parascene\help\index.html"),
            None,
        );
        assert_eq!(
            verbatim,
            "file:///C:/Program%20Files/Parascene/help/index.html"
        );
    }
}
