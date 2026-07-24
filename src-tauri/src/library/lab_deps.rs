//! Local tool readiness for Lab (FFmpeg, Demucs) — status + guided install.

use super::ffmpeg::resolve_ffmpeg;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabToolStatus {
    pub id: String,
    pub label: String,
    pub ready: bool,
    pub path: Option<String>,
    pub detail: String,
    pub install_hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabDepsStatus {
    pub ffmpeg: LabToolStatus,
    pub demucs: LabToolStatus,
    pub whisper: LabToolStatus,
    /// Absolute path to LOCAL_TOOLS.md when found (dev checkout / beside app).
    pub doc_path: Option<String>,
}

fn tool(
    id: &str,
    label: &str,
    path: Option<PathBuf>,
    missing_detail: &str,
    install_hint: &str,
) -> LabToolStatus {
    match path {
        Some(p) => LabToolStatus {
            id: id.into(),
            label: label.into(),
            ready: true,
            path: Some(p.display().to_string()),
            detail: format!("Found at {}", p.display()),
            install_hint: install_hint.into(),
        },
        None => LabToolStatus {
            id: id.into(),
            label: label.into(),
            ready: false,
            path: None,
            detail: missing_detail.into(),
            install_hint: install_hint.into(),
        },
    }
}

fn ffmpeg_install_hint() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "winget install ffmpeg"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "brew install ffmpeg"
    }
}

fn ffmpeg_missing_detail() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Not found on PATH"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Not found on PATH or Homebrew locations"
    }
}

fn pip_install_hint(package: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        format!("python -m pip install --user {package}")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("python3 -m pip install --user {package}")
    }
}

/// Resolve `demucs` for Lab vocals — PATH plus common user bins.
pub(crate) fn resolve_demucs() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = probe_on_augmented_path("demucs") {
        candidates.push(p);
    }

    let home = dirs_home();
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin/demucs"));
        // Dedicated Parascene / agent venv (pipx-style install on PEP 668 Homebrew Python).
        candidates.push(home.join(".local/share/demucs-venv/bin/demucs"));
        #[cfg(target_os = "macos")]
        {
            // ~/Library/Python/3.x/bin/demucs
            let py_root = home.join("Library/Python");
            if let Ok(entries) = std::fs::read_dir(&py_root) {
                for entry in entries.flatten() {
                    candidates.push(entry.path().join("bin/demucs"));
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            // %APPDATA%\Python\Python3x\Scripts\demucs.exe
            if let Some(data) = dirs::data_dir() {
                let py_root = data.join("Python");
                if let Ok(entries) = std::fs::read_dir(&py_root) {
                    for entry in entries.flatten() {
                        let scripts = entry.path().join("Scripts");
                        candidates.push(scripts.join("demucs.exe"));
                        candidates.push(scripts.join("demucs"));
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/demucs"));
        candidates.push(PathBuf::from("/usr/local/bin/demucs"));
    }

    for path in candidates {
        if cli_runs(&path) {
            return Some(path);
        }
    }
    None
}

fn cli_runs(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    // Many CLIs exit non-zero with no args; --help is enough to prove the binary.
    Command::new(path)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve `whisper` for Lab lyric align — PATH plus common user bins.
pub(crate) fn resolve_whisper() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = probe_on_augmented_path("whisper") {
        candidates.push(p);
    }

    if let Some(home) = dirs_home() {
        candidates.push(home.join(".local/bin/whisper"));
        #[cfg(target_os = "macos")]
        {
            let py_root = home.join("Library/Python");
            if let Ok(entries) = std::fs::read_dir(&py_root) {
                for entry in entries.flatten() {
                    candidates.push(entry.path().join("bin/whisper"));
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(data) = dirs::data_dir() {
                let py_root = data.join("Python");
                if let Ok(entries) = std::fs::read_dir(&py_root) {
                    for entry in entries.flatten() {
                        let scripts = entry.path().join("Scripts");
                        candidates.push(scripts.join("whisper.exe"));
                        candidates.push(scripts.join("whisper"));
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/whisper"));
        candidates.push(PathBuf::from("/usr/local/bin/whisper"));
    }

    for path in candidates {
        if cli_runs(&path) {
            return Some(path);
        }
    }
    None
}

/// Probe a CLI name on PATH (plus augmented dirs) the same way ffmpeg does.
fn probe_on_augmented_path(name: &str) -> Option<PathBuf> {
    let path_env = augmented_path_env();
    let ok = Command::new(name)
        .arg("--help")
        .env("PATH", &path_env)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Some(PathBuf::from(name))
    } else {
        None
    }
}

fn augmented_path_env() -> std::ffi::OsString {
    let path_env = std::env::var_os("PATH").unwrap_or_default();
    let extras = augmented_path_dirs();
    if extras.is_empty() {
        return path_env;
    }
    let mut parts: Vec<PathBuf> = std::env::split_paths(&path_env).collect();
    for extra in extras {
        if !parts.iter().any(|p| p == &extra) {
            parts.push(extra);
        }
    }
    std::env::join_paths(parts).unwrap_or(path_env)
}

fn augmented_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    }
    if let Some(home) = dirs_home() {
        dirs.push(home.join(".local/bin"));
        #[cfg(target_os = "macos")]
        {
            let py_root = home.join("Library/Python");
            if let Ok(entries) = std::fs::read_dir(py_root) {
                for entry in entries.flatten() {
                    dirs.push(entry.path().join("bin"));
                }
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Some(data) = dirs::data_dir() {
                let py_root = data.join("Python");
                if let Ok(entries) = std::fs::read_dir(py_root) {
                    for entry in entries.flatten() {
                        dirs.push(entry.path().join("Scripts"));
                    }
                }
            }
        }
    }
    dirs
}

fn dirs_home() -> Option<PathBuf> {
    dirs::home_dir()
}

pub(crate) fn local_tools_doc_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    // Dev: src-tauri/../LOCAL_TOOLS.md
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../LOCAL_TOOLS.md"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("LOCAL_TOOLS.md"));
        candidates.push(cwd.join("../LOCAL_TOOLS.md"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("LOCAL_TOOLS.md"));
            candidates.push(dir.join("../../../LOCAL_TOOLS.md"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn lab_deps_status_now() -> LabDepsStatus {
    let ffmpeg_path = resolve_ffmpeg();
    let demucs_path = resolve_demucs();
    let whisper_path = resolve_whisper();
    LabDepsStatus {
        ffmpeg: tool(
            "ffmpeg",
            "FFmpeg",
            ffmpeg_path,
            ffmpeg_missing_detail(),
            ffmpeg_install_hint(),
        ),
        demucs: tool(
            "demucs",
            "Demucs",
            demucs_path,
            "Not found — required for vocals isolate / a2v stems",
            &pip_install_hint("demucs"),
        ),
        whisper: tool(
            "whisper",
            "Whisper",
            whisper_path,
            "Not found — optional for local lyric transcription",
            &pip_install_hint("openai-whisper"),
        ),
        doc_path: local_tools_doc_path().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn library_lab_deps_status() -> LabDepsStatus {
    lab_deps_status_now()
}

/// Run `python -m pip install --user demucs` (downloads torch; may take several minutes).
#[tauri::command]
pub async fn library_install_demucs() -> Result<LabDepsStatus, String> {
    let python = resolve_python().ok_or_else(|| {
        "Python 3 not found — install Python 3, then retry (see LOCAL_TOOLS.md)".to_string()
    })?;

    let python_for_thread = python.clone();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&python_for_thread)
            .args(["-m", "pip", "install", "--user", "demucs"])
            .output()
    })
    .await
    .map_err(|e| format!("Install task failed: {e}"))?
    .map_err(|e| format!("Could not run pip install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = format!("{stderr}\n{stdout}");
        return Err(format!(
            "demucs install failed (exit {}): {}",
            output.status,
            detail.chars().take(800).collect::<String>()
        ));
    }

    let status = lab_deps_status_now();
    if !status.demucs.ready {
        #[cfg(target_os = "windows")]
        {
            return Err(
                "pip reported success but demucs still not found — add %APPDATA%\\Python\\Python3x\\Scripts to PATH, or reopen the app (see LOCAL_TOOLS.md)"
                    .into(),
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(
                "pip reported success but demucs still not found — add ~/Library/Python/*/bin or ~/.local/bin to PATH, or reopen the app (see LOCAL_TOOLS.md)"
                    .into(),
            );
        }
    }
    Ok(status)
}

fn resolve_python() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("python3"),
        PathBuf::from("python"),
    ];
    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("python.exe"));
        candidates.push(PathBuf::from("python3.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
        candidates.push(PathBuf::from("/usr/bin/python3"));
    }

    for path in candidates {
        let ok = Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(path);
        }
    }
    None
}

/// Open LOCAL_TOOLS.md in the default editor/viewer when present on disk.
#[tauri::command]
pub fn library_open_local_tools_doc(app: tauri::AppHandle) -> Result<(), String> {
    let path = local_tools_doc_path()
        .ok_or_else(|| "LOCAL_TOOLS.md not found next to this checkout".to_string())?;
    app.opener()
        .open_path(path.display().to_string(), None::<String>)
        .map_err(|e| format!("Could not open LOCAL_TOOLS.md: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_struct_is_stable() {
        let s = lab_deps_status_now();
        assert_eq!(s.ffmpeg.id, "ffmpeg");
        assert_eq!(s.demucs.id, "demucs");
    }
}
