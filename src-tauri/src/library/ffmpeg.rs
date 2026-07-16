//! Shared FFmpeg binary resolution for local media tools.

use std::path::PathBuf;
use std::process::Command;

pub fn resolve_ffmpeg() -> Option<PathBuf> {
    let candidates = [
        "ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
    ];
    for c in candidates {
        let path = PathBuf::from(c);
        let ok = Command::new(&path)
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(if c == "ffmpeg" {
                PathBuf::from("ffmpeg")
            } else {
                path
            });
        }
    }
    None
}
