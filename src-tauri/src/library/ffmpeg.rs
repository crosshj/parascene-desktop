//! Shared FFmpeg binary resolution for local media tools.

use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Build a `Command` that does not flash a console window on Windows.
///
/// GUI apps (`windows_subsystem = "windows"`) still spawn a visible terminal for
/// console-subsystem tools like `ffmpeg.exe` unless `CREATE_NO_WINDOW` is set.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

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
        let ok = command(&path)
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
