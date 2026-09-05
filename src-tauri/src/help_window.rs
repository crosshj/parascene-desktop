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
];

pub fn help_page(topic_id: Option<&str>) -> &'static str {
    let key = topic_id.unwrap_or("").trim();
    PAGES
        .iter()
        .find(|(id, _)| *id == key)
        .map(|(_, path)| *path)
        .unwrap_or("help/index.html")
}

pub fn show_help(app: &AppHandle, topic_id: Option<&str>) -> Result<Value, String> {
    let page = help_page(topic_id);
    if let Some(existing) = app.get_webview_window(HELP_WINDOW_LABEL) {
        if topic_id.is_some() {
            navigate_help(&existing, page)?;
        }
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(json!({ "ok": true, "focused": true, "page": page }));
    }

    let app_path = page.split_once('#').map(|(path, _)| path).unwrap_or(page);
    let window = WebviewWindowBuilder::new(
        app,
        HELP_WINDOW_LABEL,
        WebviewUrl::App(app_path.into()),
    )
    .title("Parascene Help")
    .inner_size(880.0, 720.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    if page.contains('#') {
        let _ = navigate_help(&window, page);
    }

    Ok(json!({ "ok": true, "opened": true, "page": page }))
}

fn navigate_help(window: &WebviewWindow, page: &str) -> Result<(), String> {
    let (path, hash) = match page.split_once('#') {
        Some((path, hash)) => (path, Some(hash)),
        None => (page, None),
    };
    let mut url = window.url().map_err(|e| e.to_string())?;
    url.set_path(&format!("/{path}"));
    url.set_query(None);
    url.set_fragment(hash);
    window.navigate(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_help_window(app: AppHandle, topic_id: Option<String>) -> Result<Value, String> {
    show_help(&app, topic_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::help_page;

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
        assert_eq!(help_page(Some("library")), "help/overview.html#library");
        assert_eq!(help_page(Some("director")), "help/overview.html#director");
        assert_eq!(help_page(Some("nope")), "help/index.html");
    }
}
