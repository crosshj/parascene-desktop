//! Local tool readiness for Lab (FFmpeg, Demucs) — status + guided install.

use super::ffmpeg::{self, resolve_ffmpeg};
use serde::Serialize;
use std::path::{Path, PathBuf};
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
    }

    // Shared pip Scripts/bin dirs (Windows APPDATA + LOCALAPPDATA Programs, etc.).
    for dir in python_user_script_dirs() {
        #[cfg(target_os = "windows")]
        {
            candidates.push(dir.join("demucs.exe"));
            candidates.push(dir.join("demucs"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            candidates.push(dir.join("demucs"));
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
    // Do NOT use this for Whisper — `whisper --help` imports Torch and is slow/fragile
    // on Windows (GUI PATH, CUDA probes, non-zero help exits).
    ffmpeg::command(path)
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// How to invoke local Whisper once resolved.
#[derive(Debug, Clone)]
pub(crate) enum WhisperLaunch {
    /// `whisper` / `whisper.exe` console script.
    Binary(PathBuf),
    /// Package installed but shim missing/off PATH — `python -m whisper`.
    PythonModule(PathBuf),
}

impl WhisperLaunch {
    pub(crate) fn display_path(&self) -> String {
        match self {
            Self::Binary(p) => p.display().to_string(),
            Self::PythonModule(py) => format!("{} -m whisper", py.display()),
        }
    }

    pub(crate) fn command(&self) -> std::process::Command {
        match self {
            Self::Binary(p) => ffmpeg::command(p),
            Self::PythonModule(py) => {
                let mut cmd = ffmpeg::command(py);
                cmd.args(["-m", "whisper"]);
                cmd
            }
        }
    }
}

/// Resolve Whisper without running `whisper --help` (Torch import is too heavy/fragile).
///
/// Order: absolute shim on disk → `where`/`which` on augmented PATH → `python -m whisper`
/// when `openai-whisper` is installed for a discovered Python.
pub(crate) fn resolve_whisper() -> Option<WhisperLaunch> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Prefer absolute hits from PATH lookup (works even when --help would fail).
    for name in whisper_cli_basenames() {
        if let Some(abs) = which_on_augmented_path(name) {
            candidates.push(abs);
        }
    }

    for dir in python_user_script_dirs() {
        for name in whisper_cli_basenames() {
            candidates.push(dir.join(name));
        }
    }

    if let Some(home) = dirs_home() {
        candidates.push(home.join(".local/bin/whisper"));
        #[cfg(target_os = "windows")]
        {
            candidates.push(home.join(".local/bin/whisper.exe"));
            // Common Conda / Miniforge layouts (not always on GUI PATH).
            for root in ["anaconda3", "miniconda3", "miniforge3", "mambaforge"] {
                let scripts = home.join(root).join("Scripts");
                candidates.push(scripts.join("whisper.exe"));
                candidates.push(scripts.join("whisper"));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/whisper"));
        candidates.push(PathBuf::from("/usr/local/bin/whisper"));
    }

    let mut seen = std::collections::HashSet::<PathBuf>::new();
    for path in candidates {
        if !seen.insert(path.clone()) {
            continue;
        }
        if whisper_shim_present(&path) {
            return Some(WhisperLaunch::Binary(path));
        }
    }

    // Shim missing/off PATH, but pip package present → still runnable.
    if let Some(python) = resolve_python() {
        if python_has_openai_whisper(&python) {
            return Some(WhisperLaunch::PythonModule(python));
        }
    }

    None
}

fn whisper_cli_basenames() -> &'static [&'static str] {
    #[cfg(target_os = "windows")]
    {
        &["whisper.exe", "whisper.cmd", "whisper"]
    }
    #[cfg(not(target_os = "windows"))]
    {
        &["whisper"]
    }
}

/// True when the Whisper console script exists (no Torch import).
fn whisper_shim_present(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    if path.is_absolute() || path.components().count() > 1 {
        return path.is_file();
    }
    which_on_augmented_path(path.to_str().unwrap_or("whisper"))
        .map(|p| p.is_file())
        .unwrap_or(false)
}

/// Resolve a bare command name to an absolute path using augmented PATH.
fn which_on_augmented_path(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let path_env = augmented_path_env();

    #[cfg(target_os = "windows")]
    {
        let output = ffmpeg::command("where.exe")
            .arg(name)
            .env("PATH", &path_env)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let candidate = PathBuf::from(trimmed);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = ffmpeg::command("which")
            .arg(name)
            .env("PATH", &path_env)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let trimmed = stdout.lines().next()?.trim();
        if trimmed.is_empty() {
            return None;
        }
        let candidate = PathBuf::from(trimmed);
        candidate.is_file().then_some(candidate)
    }
}

/// `pip show` proves the wheel is installed without importing Torch.
fn python_has_openai_whisper(python: &Path) -> bool {
    ffmpeg::command(python)
        .args(["-m", "pip", "show", "openai-whisper"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Probe a CLI name on PATH (plus augmented dirs) the same way ffmpeg does.
fn probe_on_augmented_path(name: &str) -> Option<PathBuf> {
    let path_env = augmented_path_env();
    let ok = ffmpeg::command(name)
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

/// Python user / install `Scripts` (Windows) or `bin` (macOS) dirs that hold pip shims.
fn python_user_script_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    #[cfg(target_os = "macos")]
    if let Some(home) = dirs_home() {
        let py_root = home.join("Library/Python");
        if let Ok(entries) = std::fs::read_dir(py_root) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
        dirs.push(home.join(".local/bin"));
    }

    #[cfg(target_os = "windows")]
    {
        // pip --user → %APPDATA%\Python\Python3x\Scripts
        if let Some(roaming) = dirs::data_dir() {
            push_child_scripts_dirs(&mut dirs, &roaming.join("Python"));
        }
        // python.org installer → %LOCALAPPDATA%\Programs\Python\Python3x\Scripts
        if let Some(local) = dirs::data_local_dir() {
            push_child_scripts_dirs(&mut dirs, &local.join("Programs").join("Python"));
            // Some embeds / older layouts
            push_child_scripts_dirs(&mut dirs, &local.join("Python"));
        }
        if let Some(home) = dirs_home() {
            let local_bin = home.join(".local").join("bin");
            if local_bin.is_dir() {
                dirs.push(local_bin);
            }
        }
    }

    dirs
}

#[cfg(target_os = "windows")]
fn push_child_scripts_dirs(out: &mut Vec<PathBuf>, py_root: &Path) {
    let Ok(entries) = std::fs::read_dir(py_root) else {
        return;
    };
    for entry in entries.flatten() {
        let scripts = entry.path().join("Scripts");
        if scripts.is_dir() {
            out.push(scripts);
        }
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
    // pip --user Scripts/bin dirs (Finder/GUI PATH often omits these on both OSes).
    for dir in python_user_script_dirs() {
        if !dirs.iter().any(|d| d == &dir) {
            dirs.push(dir);
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
    let whisper = resolve_whisper();
    let whisper_hint = pip_install_hint("openai-whisper");
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
        whisper: match whisper {
            Some(launch) => {
                let path = launch.display_path();
                LabToolStatus {
                    id: "whisper".into(),
                    label: "Whisper".into(),
                    ready: true,
                    path: Some(path.clone()),
                    detail: format!("Found at {path}"),
                    install_hint: whisper_hint,
                }
            }
            None => LabToolStatus {
                id: "whisper".into(),
                label: "Whisper".into(),
                ready: false,
                path: None,
                detail: whisper_missing_detail().into(),
                install_hint: whisper_hint,
            },
        },
        doc_path: local_tools_doc_path().map(|p| p.display().to_string()),
    }
}

fn whisper_missing_detail() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "Not found — optional for local lyric transcription (checked PATH, %APPDATA%\\Python\\*\\Scripts, %LOCALAPPDATA%\\Programs\\Python\\*\\Scripts, and python -m whisper)"
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Not found — optional for local lyric transcription"
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
        ffmpeg::command(&python_for_thread)
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
        // Windows py launcher (often available when `python` is the Store stub).
        candidates.push(PathBuf::from("py.exe"));
        if let Some(local) = dirs::data_local_dir() {
            let programs = local.join("Programs").join("Python");
            if let Ok(entries) = std::fs::read_dir(programs) {
                let mut versions: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path().join("python.exe"))
                    .filter(|p| p.is_file())
                    .collect();
                // Prefer newer installs when names sort (Python313 > Python312).
                versions.sort();
                versions.reverse();
                candidates.extend(versions);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
        candidates.push(PathBuf::from("/usr/bin/python3"));
    }

    for path in candidates {
        let resolved = resolve_python_candidate(&path);
        let Some(resolved) = resolved else {
            continue;
        };
        if is_windows_apps_python_stub(&resolved) {
            continue;
        }
        return Some(resolved);
    }
    None
}

fn resolve_python_candidate(path: &Path) -> Option<PathBuf> {
    let is_py_launcher = path
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("py"));

    let mut cmd = ffmpeg::command(path);
    if is_py_launcher {
        cmd.args(["-3", "--version"]);
    } else {
        cmd.arg("--version");
    }
    let ok = cmd
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return None;
    }

    if is_py_launcher {
        return resolve_python_via_py_launcher(path);
    }

    if path.is_absolute() || path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }

    // Prefer absolute path so later `pip show` / `-m whisper` hit the same interpreter.
    which_on_augmented_path(path.to_str()?).or_else(|| Some(path.to_path_buf()))
}

fn is_windows_apps_python_stub(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    lower.contains(r"\windowsapps\") || lower.contains("/windowsapps/")
}

#[cfg(target_os = "windows")]
fn resolve_python_via_py_launcher(py: &Path) -> Option<PathBuf> {
    let output = ffmpeg::command(py)
        .args(["-3", "-c", "import sys; print(sys.executable)"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let trimmed = line.lines().next()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    path.is_file().then_some(path)
}

#[cfg(not(target_os = "windows"))]
fn resolve_python_via_py_launcher(_py: &Path) -> Option<PathBuf> {
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
        assert_eq!(s.whisper.id, "whisper");
    }

    #[test]
    fn whisper_launch_display_distinguishes_module() {
        let binary = WhisperLaunch::Binary(PathBuf::from("/tmp/whisper"));
        assert_eq!(binary.display_path(), "/tmp/whisper");
        let module = WhisperLaunch::PythonModule(PathBuf::from("/usr/bin/python3"));
        assert!(module.display_path().contains("-m whisper"));
    }

    #[test]
    fn windows_apps_stub_paths_are_rejected() {
        assert!(is_windows_apps_python_stub(Path::new(
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\python.exe"
        )));
        assert!(!is_windows_apps_python_stub(Path::new(
            r"C:\Users\x\AppData\Local\Programs\Python\Python312\python.exe"
        )));
    }

    #[test]
    fn whisper_cli_basenames_include_windows_exe() {
        let names = whisper_cli_basenames();
        assert!(names.contains(&"whisper"));
        #[cfg(target_os = "windows")]
        {
            assert!(names.contains(&"whisper.exe"));
        }
    }
}
