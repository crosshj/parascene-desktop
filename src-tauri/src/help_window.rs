use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

/// Runs before page JS so Escape still closes a blank / failed load.
const HELP_CLOSE_SCRIPT: &str = r#"
(function () {
  function closeHelp() {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke("close_help_window");
        return;
      }
    } catch (e) {}
    try { window.close(); } catch (e) {}
  }
  window.__parasceneCloseHelp = closeHelp;
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeHelp();
    }
  });
})();
"#;

pub fn help_page(topic_id: Option<&str>) -> &'static str {
    let key = topic_id.unwrap_or("").trim();
    PAGES
        .iter()
        .find(|(id, _)| *id == key)
        .map(|(_, path)| *path)
        .unwrap_or("help/index.html")
}

/// Forward-slash asset path. Never a Windows PathBuf (`help\index.html`
/// misses the bundled file and Tauri falls back to the React app).
fn help_asset_parts(page: &str) -> (String, Option<String>) {
    let page = page.trim().replace('\\', "/");
    let page = page.trim_start_matches('/');
    match page.split_once('#') {
        Some((path, hash)) => (path.to_string(), Some(hash.to_string())),
        None => (page.to_string(), None),
    }
}

fn help_webview_url(app: &AppHandle, page: &str) -> Result<WebviewUrl, String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let mut url = main.url().map_err(|e| e.to_string())?;
    let (path, hash) = help_asset_parts(page);
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.set_fragment(hash.as_deref());
    Ok(WebviewUrl::External(url))
}

fn focus_help(window: &WebviewWindow, page: &str, navigate: bool) -> Result<Value, String> {
    if navigate {
        navigate_help(window, page)?;
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    Ok(json!({ "ok": true, "focused": true, "page": page }))
}

fn navigate_help(window: &WebviewWindow, page: &str) -> Result<(), String> {
    let mut url = window.url().map_err(|e| e.to_string())?;
    let (path, hash) = help_asset_parts(page);
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.set_fragment(hash.as_deref());
    window.navigate(url).map_err(|e| e.to_string())
}

fn create_help_window(app: &AppHandle, page: &str) -> Result<Value, String> {
    if let Some(existing) = app.get_webview_window(HELP_WINDOW_LABEL) {
        return focus_help(&existing, page, true);
    }

    let url = help_webview_url(app, page)?;
    let window = WebviewWindowBuilder::new(app, HELP_WINDOW_LABEL, url)
        .title("Parascene Help")
        .inner_size(880.0, 720.0)
        .min_inner_size(560.0, 420.0)
        .decorations(true)
        .closable(true)
        .center()
        .initialization_script(HELP_CLOSE_SCRIPT)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(json!({ "ok": true, "opened": true, "page": page }))
}

pub fn show_help(app: &AppHandle, topic_id: Option<&str>) -> Result<Value, String> {
    let page = help_page(topic_id);
    if let Some(existing) = app.get_webview_window(HELP_WINDOW_LABEL) {
        return focus_help(&existing, page, topic_id.is_some());
    }

    // WebView2 (and some packaged WKWebView builds) must create windows on
    // the UI thread. Invoke/agent handlers are not that thread. Do not wait
    // here — a menu event is already on the main thread and recv would deadlock.
    let app_main = app.clone();
    let page_owned = page.to_string();
    app.run_on_main_thread(move || {
        if let Err(error) = create_help_window(&app_main, &page_owned) {
            eprintln!("help window: {error}");
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(json!({ "ok": true, "opened": true, "page": page }))
}

#[tauri::command]
pub fn open_help_window(app: AppHandle, topic_id: Option<String>) -> Result<Value, String> {
    show_help(&app, topic_id.as_deref())
}

#[tauri::command]
pub fn close_help_window(app: AppHandle) -> Result<Value, String> {
    if let Some(window) = app.get_webview_window(HELP_WINDOW_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(json!({ "ok": true, "closed": true }))
}

#[cfg(test)]
mod tests {
    use super::{help_asset_parts, help_page};

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
}
