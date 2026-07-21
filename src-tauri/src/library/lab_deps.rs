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

/// Resolve `demucs` for Lab vocals — PATH plus common user/Homebrew bins.
pub(crate) fn resolve_demucs() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = which_on_augmented_path("demucs") {
        candidates.push(p);
    }

    let home = dirs_home();
    if let Some(home) = &home {
        candidates.push(home.join(".local/bin/demucs"));
        // ~/Library/Python/3.x/bin/demucs
        let py_root = home.join("Library/Python");
        if let Ok(entries) = std::fs::read_dir(&py_root) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin/demucs");
                candidates.push(bin);
            }
        }
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/demucs"));
    candidates.push(PathBuf::from("/usr/local/bin/demucs"));

    for path in candidates {
        if demucs_runs(&path) {
            return Some(path);
        }
    }
    None
}

fn demucs_runs(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    // `demucs` with no args often exits non-zero; --help is enough to prove the CLI.
    Command::new(path)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn whisper_runs(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    Command::new(path)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Resolve `whisper` for Lab lyric align — PATH plus common user/Homebrew bins.
pub(crate) fn resolve_whisper() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(p) = which_on_augmented_path("whisper") {
        candidates.push(p);
    }

    if let Some(home) = dirs_home() {
        candidates.push(home.join(".local/bin/whisper"));
        let py_root = home.join("Library/Python");
        if let Ok(entries) = std::fs::read_dir(&py_root) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join("bin/whisper"));
            }
        }
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/whisper"));
    candidates.push(PathBuf::from("/usr/local/bin/whisper"));

    for path in candidates {
        if whisper_runs(&path) {
            return Some(path);
        }
    }
    None
}

fn which_on_augmented_path(name: &str) -> Option<PathBuf> {
    let mut path_env = std::env::var_os("PATH").unwrap_or_default();
    let extras = augmented_path_dirs();
    if !extras.is_empty() {
        let mut parts: Vec<PathBuf> = std::env::split_paths(&path_env).collect();
        for extra in extras {
            if !parts.iter().any(|p| p == &extra) {
                parts.push(extra);
            }
        }
        if let Ok(joined) = std::env::join_paths(parts) {
            path_env = joined;
        }
    }

    let output = Command::new("which")
        .arg(name)
        .env("PATH", path_env)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn augmented_path_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ];
    if let Some(home) = dirs_home() {
        dirs.push(home.join(".local/bin"));
        let py_root = home.join("Library/Python");
        if let Ok(entries) = std::fs::read_dir(py_root) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join("bin"));
            }
        }
    }
    dirs
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
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
            "Not found on PATH or Homebrew locations",
            "brew install ffmpeg",
        ),
        demucs: tool(
            "demucs",
            "Demucs",
            demucs_path,
            "Not found — required for vocals isolate / a2v stems",
            "python3 -m pip install --user demucs",
        ),
        whisper: tool(
            "whisper",
            "Whisper",
            whisper_path,
            "Not found — optional for local lyric transcription",
            "python3 -m pip install --user openai-whisper",
        ),
        doc_path: local_tools_doc_path().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn library_lab_deps_status() -> LabDepsStatus {
    lab_deps_status_now()
}

/// Run `python3 -m pip install --user demucs` (downloads torch; may take several minutes).
#[tauri::command]
pub async fn library_install_demucs() -> Result<LabDepsStatus, String> {
    let python = resolve_python3().ok_or_else(|| {
        "python3 not found — install Python 3, then retry (see LOCAL_TOOLS.md)".to_string()
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
        return Err(
            "pip reported success but demucs still not found — add ~/Library/Python/*/bin or ~/.local/bin to PATH, or reopen the app (see LOCAL_TOOLS.md)"
                .into(),
        );
    }
    Ok(status)
}

fn resolve_python3() -> Option<PathBuf> {
    for c in [
        "python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ] {
        let path = PathBuf::from(c);
        let ok = Command::new(&path)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(if c == "python3" {
                PathBuf::from("python3")
            } else {
                path
            });
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
