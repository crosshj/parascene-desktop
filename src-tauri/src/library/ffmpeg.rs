//! Shared FFmpeg binary resolution for local media tools.

use std::path::PathBuf;
use std::process::Command;

pub fn resolve_ffmpeg() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![PathBuf::from("ffmpeg")];
    #[cfg(target_os = "windows")]
    {
        candidates.push(PathBuf::from("ffmpeg.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin/ffmpeg"));
        candidates.push(PathBuf::from("/usr/local/bin/ffmpeg"));
    }

    for path in candidates {
        let ok = Command::new(&path)
            .arg("-version")
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
