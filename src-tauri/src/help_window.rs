use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Files Vite copies from `public/help/` into `dist/help/` (then into the binary).
const HELP_FILES: &[&str] = &[
    "help/audio.html",
    "help/desktop/media/agent-test-speech.mp3",
    "help/desktop/media/agent-test-speech.mp4",
    "help/desktop/media/agent-test-speech.wav",
    "help/desktop/media/agent-test-still.png",
    "help/desktop/media/models/blue-flux-flux1-dev-fp8.png",
    "help/desktop/media/models/blue-flux-flux1-dev.png",
    "help/desktop/media/models/blue-flux-flux1-krea-dev-fp8-scaled.png",
    "help/desktop/media/models/blue-flux-flux1-schnell-fp8.png",
    "help/desktop/media/models/blue-flux-flux1-schnell.png",
    "help/desktop/media/models/blue-flux-getphatfluxreality-v10fp8.png",
    "help/desktop/media/models/blue-flux-getphatfluxreality-v5hardcorefp8.png",
    "help/desktop/media/models/blue-flux-real-dream-flux-1-fp8.png",
    "help/desktop/media/models/blue-flux-stoiqoafroditefluxxl-f1dalpha.png",
    "help/desktop/media/models/blue-flux-stoiqonewrealityfluxsd35-f1dalphatwo.png",
    "help/desktop/media/models/blue-pony-cyberrealisticpony-v130.png",
    "help/desktop/media/models/blue-qwen-qwen-rapid-aio-nsfw-v9.png",
    "help/desktop/media/models/blue-sd15-cyberrealistic-v20.png",
    "help/desktop/media/models/blue-sd15-deliberate-v11.png",
    "help/desktop/media/models/blue-sd15-dreamshaper-8-pruned.png",
    "help/desktop/media/models/blue-sd15-liberty-main.png",
    "help/desktop/media/models/blue-sd15-lofi-v2pre.png",
    "help/desktop/media/models/blue-sd15-qgo10b-qgo10b.png",
    "help/desktop/media/models/blue-sd15-realisticvisionv60b1-v60b1vae.png",
    "help/desktop/media/models/blue-sd15-revanimated-v122.png",
    "help/desktop/media/models/blue-sd15-rpg-v5.png",
    "help/desktop/media/models/blue-sd15-tooname-version20.png",
    "help/desktop/media/models/blue-sdxl-dreamshaperxl-turbodpmppsde.png",
    "help/desktop/media/models/blue-sdxl-illustriousxl20-v20.png",
    "help/desktop/media/models/blue-sdxl-juggernautxl-v7rundiffusion.png",
    "help/desktop/media/models/blue-sdxl-juggernautxl-v9rdphoto2lightning.png",
    "help/desktop/media/models/blue-sdxl-protovisionxlhighfidelity3d-releasev660bakedvae.png",
    "help/desktop/media/models/blue-sdxl-realcartoonxl-v6.png",
    "help/desktop/media/models/blue-sdxl-realdream-sdxllightning1.png",
    "help/desktop/media/models/blue-sdxl-sd-xl-base-1-0.png",
    "help/desktop/media/models/blue-sdxl-sd-xl-turbo-1-0-fp16.png",
    "help/desktop/media/models/blue-sdxl-zavychromaxl-v40.png",
    "help/desktop/media/models/blue-z-image-z-image-turbo-bf16.png",
    "help/desktop/media/models/pixellab-bitforge.png",
    "help/desktop/media/models/pixellab-pixflux.png",
    "help/desktop/media/models/replicate-bfl-flux-2-pro.png",
    "help/desktop/media/models/replicate-bytedance-sdxl-lightning-4-step.png",
    "help/desktop/media/models/replicate-bytedance-seedream-4.png",
    "help/desktop/media/models/replicate-google-nano-banana-gemini-2-5.png",
    "help/desktop/media/models/replicate-leonardo-ai-lucid-origin.png",
    "help/desktop/media/models/replicate-luma-photon.png",
    "help/desktop/media/models/replicate-minimax-image-01.png",
    "help/desktop/media/models/replicate-pro-bfl-flux-2-max.png",
    "help/desktop/media/models/replicate-pro-google-nano-banana-2.png",
    "help/desktop/media/models/replicate-pro-google-nano-banana-pro.png",
    "help/desktop/media/models/replicate-pro-openai-gpt-image-1-5.png",
    "help/desktop/media/models/replicate-prunaai-p-image.png",
    "help/desktop/media/models/replicate-prunaai-z-image-turbo.png",
    "help/desktop/media/models/replicate-qwen-image.png",
    "help/desktop/media/models/replicate-recraft-v4.png",
    "help/desktop/media/models/replicate-stability-ai-sdxl.png",
    "help/desktop/screens/director.png",
    "help/desktop/screens/editor-a2v.png",
    "help/desktop/screens/editor-a2v-form.png",
    "help/desktop/screens/editor-audio-timeline.png",
    "help/desktop/screens/editor-generate-prompt.png",
    "help/desktop/screens/editor-generate-result.png",
    "help/desktop/screens/editor-new-asset.png",
    "help/desktop/screens/editor.png",
    "help/desktop/screens/library.png",
    "help/desktop/screens/login.png",
    "help/desktop/screens/projects.png",
    "help/desktop/screens/settings.png",
    "help/desktop/screens/sync.png",
    "help/folders.html",
    "help/fonts/OFL.txt",
    "help/fonts/inter-latin-ext-wght-normal.woff2",
    "help/fonts/inter-latin-wght-normal.woff2",
    "help/generate.html",
    "help/getting-started.html",
    "help/help.css",
    "help/help.js",
    "help/image-models.html",
    "help/index.html",
    "help/overview.html",
    "help/projects.html",
    "help/settings.html",
    "help/sync.html",
    "help/tools.html",
    "help/video-models.html",
];

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
    ("image-models", "help/image-models.html"),
    ("models", "help/image-models.html"),
    ("image-model", "help/image-models.html"),
    ("video-models", "help/video-models.html"),
    ("video-model", "help/video-models.html"),
    ("audio", "help/audio.html"),
    ("speech", "help/audio.html"),
    ("a2v", "help/audio.html"),
    ("audio-to-video", "help/audio.html"),
    ("settings", "help/settings.html"),
    ("labs", "help/settings.html"),
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

fn checkout_help_dir() -> Option<PathBuf> {
    if !tauri::is_dev() {
        return None;
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/help");
    dir.join("index.html").is_file().then_some(dir)
}

/// Path the OS shell will accept (no Windows `\\?\` prefix).
fn shell_open_path(path: &Path) -> String {
    let mut text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        text = format!(r"\\{rest}");
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    text
}

fn materialize_bundled_help(app: &AppHandle) -> Result<PathBuf, String> {
    let dest = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("help");
    let resolver = app.asset_resolver();
    for rel in HELP_FILES {
        let Some(asset) = resolver.get((*rel).to_string()) else {
            continue;
        };
        let file = rel.strip_prefix("help/").unwrap_or(rel);
        let path = dest.join(file);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, asset.bytes).map_err(|e| e.to_string())?;
    }
    if !dest.join("index.html").is_file() {
        return Err("Help pages were not in the app bundle".into());
    }
    Ok(dest)
}

fn resolve_help_file(app: &AppHandle, rel: &str) -> Result<PathBuf, String> {
    let file = rel.strip_prefix("help/").unwrap_or(rel);
    let root = if let Some(dir) = checkout_help_dir() {
        dir
    } else {
        materialize_bundled_help(app)?
    };
    let path = root.join(file);
    if !path.is_file() {
        return Err(format!("Help page not found ({rel})"));
    }
    Ok(std::fs::canonicalize(&path).unwrap_or(path))
}

fn help_browser_target(app: &AppHandle, page: &str) -> Result<(PathBuf, String), String> {
    let (path, hash) = help_asset_parts(page);
    let file = resolve_help_file(app, &path)?;
    let href = path_to_file_url(&file, hash.as_deref());
    Ok((file, href))
}

fn dismiss_legacy_help_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(HELP_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

pub fn show_help(app: &AppHandle, topic_id: Option<&str>) -> Result<Value, String> {
    let page = help_page(topic_id);
    dismiss_legacy_help_window(app);
    let (file, href) = help_browser_target(app, page)?;
    // open_path (not file:// open_url): on Windows, Start-Process / Explorer
    // treat a file:// URL as a blank popup instead of the default browser.
    app.opener()
        .open_path(shell_open_path(&file), None::<String>)
        .map_err(|e| format!("Could not open Help in the browser: {e}"))?;
    Ok(json!({ "ok": true, "opened": true, "in": "browser", "page": page, "href": href }))
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
    use super::{help_asset_parts, help_page, path_to_file_url, shell_open_path, HELP_FILES};
    use std::fs;
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
        assert_eq!(help_page(Some("image-models")), "help/image-models.html");
        assert_eq!(help_page(Some("models")), "help/image-models.html");
        assert_eq!(help_page(Some("video-models")), "help/video-models.html");
        assert_eq!(help_page(Some("video-model")), "help/video-models.html");
        assert_eq!(help_page(Some("audio")), "help/audio.html");
        assert_eq!(help_page(Some("speech")), "help/audio.html");
        assert_eq!(help_page(Some("a2v")), "help/audio.html");
        assert_eq!(help_page(Some("settings")), "help/settings.html");
        assert_eq!(help_page(Some("labs")), "help/settings.html");
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
    fn help_file_list_matches_checkout() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/help");
        let mut on_disk = Vec::new();
        fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    out.push(format!("help/{rel}"));
                }
            }
        }
        walk(&root, &root, &mut on_disk);
        on_disk.sort();
        let mut listed = HELP_FILES.to_vec();
        listed.sort();
        assert_eq!(listed, on_disk.iter().map(String::as_str).collect::<Vec<_>>());
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

    #[test]
    fn shell_paths_drop_windows_verbatim_prefix() {
        let plain = shell_open_path(Path::new(r"C:\Program Files\Parascene\help\index.html"));
        assert_eq!(plain, r"C:\Program Files\Parascene\help\index.html");

        let verbatim = shell_open_path(Path::new(
            r"\\?\C:\Program Files\Parascene\help\index.html",
        ));
        assert_eq!(verbatim, r"C:\Program Files\Parascene\help\index.html");
    }
}
