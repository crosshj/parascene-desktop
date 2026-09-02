//! Shared FFmpeg binary resolution for local media tools.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

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

pub fn jpeg_has_bytes(path: &Path) -> bool {
    path.is_file() && path.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

/// True when `time_sec` is the last visible source time of an untrimmed clip
/// (at/after the last 50ms of the file) or the explicit last-frame sentinel.
/// Mid-file times (trim / loop / ping-pong) stay false so we do not read past
/// the timeline out-point to the file's real EOF.
pub fn wants_last_video_frame(time_sec: f64, duration_sec: f64) -> bool {
    if time_sec >= 1.0e8 {
        return true;
    }
    if duration_sec <= 0.0 {
        return false;
    }
    time_sec + 0.05 + 1e-6 >= duration_sec
}

pub(crate) fn is_ffmpeg_banner_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    t.starts_with("ffmpeg version")
        || t.starts_with("ffprobe version")
        || t.starts_with("Copyright (c)")
        || t.starts_with("built with")
        || t.starts_with("configuration:")
        || t.starts_with("libavutil")
        || t.starts_with("libavcodec")
        || t.starts_with("libavformat")
        || t.starts_with("libavdevice")
        || t.starts_with("libavfilter")
        || t.starts_with("libswscale")
        || t.starts_with("libswresample")
        || t.starts_with("libpostproc")
        || (t.starts_with("--") && !t.contains("Error"))
}

/// Skip the version/configuration banner and keep the last useful lines.
pub(crate) fn useful_stderr(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !is_ffmpeg_banner_line(l))
        .collect();
    if !lines.is_empty() {
        return lines
            .iter()
            .rev()
            .take(12)
            .copied()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
    }
    let raw: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if raw.is_empty() {
        return stderr.chars().take(400).collect();
    }
    raw.iter()
        .rev()
        .take(8)
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn ffmpeg_tail(output: &Output) -> String {
    useful_stderr(&String::from_utf8_lossy(&output.stderr))
}

pub(crate) fn failure_message(output: &Output, prefix: &str) -> String {
    let code = output
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| output.status.to_string());
    format!("{} (exit {}): {}", prefix, code, ffmpeg_tail(output))
}

/// Write one JPEG. A non-empty file counts as success even when ffmpeg exits
/// non-zero at EOF (common when decoding through the last packet).
fn write_jpeg(ffmpeg: &Path, dest: &Path, args: &[&str]) -> Result<(), String> {
    let _ = fs::remove_file(dest);
    let output = command(ffmpeg)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if jpeg_has_bytes(dest) {
        return Ok(());
    }
    Err(failure_message(&output, "ffmpeg failed"))
}

fn write_jpeg_at_time(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    time_sec: f64,
    vf: &str,
) -> Result<(), String> {
    let t_arg = format!("{:.3}", time_sec.max(0.0));
    let src_arg = source.to_string_lossy().to_string();
    let dest_arg = dest.to_string_lossy().to_string();
    write_jpeg(
        ffmpeg,
        dest,
        &[
            "-y",
            "-i",
            &src_arg,
            "-ss",
            &t_arg,
            "-an",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            vf,
            "-q:v",
            "2",
            "-update",
            "1",
            &dest_arg,
        ],
    )
}

/// Last frame in `[start_sec, start_sec + span_sec]` (`-update 1`). Stops at
/// the timeline out-point — does not continue to file EOF.
fn write_jpeg_through(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    start_sec: f64,
    span_sec: f64,
    vf: &str,
) -> Result<(), String> {
    let start_arg = format!("{:.3}", start_sec.max(0.0));
    let span_arg = format!("{:.3}", span_sec.max(0.04));
    let src_arg = source.to_string_lossy().to_string();
    let dest_arg = dest.to_string_lossy().to_string();
    write_jpeg(
        ffmpeg,
        dest,
        &[
            "-y",
            "-i",
            &src_arg,
            "-ss",
            &start_arg,
            "-t",
            &span_arg,
            "-an",
            "-map",
            "0:v:0",
            "-vf",
            vf,
            "-q:v",
            "2",
            "-update",
            "1",
            &dest_arg,
        ],
    )
}

/// Decode from `start_sec` through EOF and keep the last frame (`-update 1`).
fn write_last_jpeg_from(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    start_sec: f64,
    vf: &str,
) -> Result<(), String> {
    let t_arg = format!("{:.3}", start_sec.max(0.0));
    let src_arg = source.to_string_lossy().to_string();
    let dest_arg = dest.to_string_lossy().to_string();
    write_jpeg(
        ffmpeg,
        dest,
        &[
            "-y",
            "-i",
            &src_arg,
            "-ss",
            &t_arg,
            "-an",
            "-map",
            "0:v:0",
            "-vf",
            vf,
            "-q:v",
            "2",
            "-update",
            "1",
            &dest_arg,
        ],
    )
}

fn write_last_jpeg(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    duration_sec: f64,
    vf: &str,
) -> Result<(), String> {
    let rewind = (duration_sec - 1.0).max(0.0);
    let mut last_err = String::new();
    for start in [rewind, 0.0] {
        match write_last_jpeg_from(ffmpeg, source, dest, start, vf) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
        if start <= 0.0 {
            break;
        }
    }
    Err(if last_err.is_empty() {
        "Could not read the last video frame".into()
    } else {
        last_err
    })
}

/// Last decoded frame at or before the timeline source time `time_sec`.
/// Untrimmed clips (time at/near file duration) read through EOF because
/// container length is often a few tens of ms past the last video packet.
/// Trimmed / looped times never read past `time_sec`.
pub fn extract_video_jpeg(
    ffmpeg: &Path,
    source: &Path,
    dest: &Path,
    time_sec: f64,
    duration_sec: f64,
    vf: &str,
) -> Result<(), String> {
    if wants_last_video_frame(time_sec, duration_sec) {
        return write_last_jpeg(ffmpeg, source, dest, duration_sec, vf);
    }

    // Do not clamp down by 50ms — that skips the last shown frames and can
    // land in the empty gap after the last video packet.
    let t = time_sec.max(0.0);
    if write_jpeg_at_time(ffmpeg, source, dest, t, vf).is_ok() {
        return Ok(());
    }
    let start = (t - 1.0).max(0.0);
    if write_jpeg_through(ffmpeg, source, dest, start, t - start, vf).is_ok() {
        return Ok(());
    }
    for delta in [0.05, 0.1, 0.25, 0.5, 1.0] {
        let earlier = t - delta;
        if earlier < 0.0 {
            break;
        }
        if write_jpeg_at_time(ffmpeg, source, dest, earlier, vf).is_ok() {
            return Ok(());
        }
    }
    Err(format!(
        "No frame at {t:.2}s (video is {duration_sec:.2}s)."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("parascene-ffmpeg-frame-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn probe_duration(ffmpeg: &Path, source: &Path) -> f64 {
        let output = command(ffmpeg)
            .args(["-hide_banner", "-i", source.to_str().unwrap()])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let idx = stderr.find("Duration:").expect("Duration in ffmpeg banner");
        let time = stderr[idx + "Duration:".len()..]
            .split(',')
            .next()
            .unwrap()
            .trim();
        let parts: Vec<&str> = time.split(':').collect();
        let h: f64 = parts[0].parse().unwrap();
        let m: f64 = parts[1].parse().unwrap();
        let s: f64 = parts[2].parse().unwrap();
        h * 3600.0 + m * 60.0 + s
    }

    /// Video stream ends ~0.5s; audio pads the container to ~1s — the case
    /// where `duration - 0.05` + `-frames:v 1` writes an empty JPEG.
    fn write_padded_video(ffmpeg: &Path, dest: &Path) -> Result<(), String> {
        let dest_arg = dest.to_string_lossy().to_string();
        let output = command(ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=24:duration=0.5",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=stereo:d=1.0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                &dest_arg,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("spawn ffmpeg: {e}"))?;
        if !output.status.success() || !dest.is_file() {
            return Err(format!(
                "could not build padded test video: {}",
                ffmpeg_tail(&output)
            ));
        }
        Ok(())
    }

    #[test]
    fn useful_stderr_skips_tessus_banner() {
        let stderr = concat!(
            "ffmpeg version 7.1.1-tessus https://evermeet.cx/ffmpeg/ Copyright (c) 2000-2024\n",
            "  built with Apple clang version 16.0.0 (clang-1600.0.26.4)\n",
            "  configuration: --cc=/usr/bin/clang --prefix=/opt/ffmpeg --enable-gpl\n",
            "  libavutil      59. 39.100 / 59. 39.100\n",
            "Error opening output file.\n",
            "width not divisible by 2 (853x480)\n",
        );
        let useful = useful_stderr(stderr);
        assert!(useful.contains("width not divisible by 2"));
        assert!(!useful.contains("ffmpeg version"));
        assert!(!useful.contains("configuration:"));
    }

    #[test]
    fn wants_last_frame_at_clamp_and_sentinel() {
        assert!(wants_last_video_frame(1.0e9, 8.9));
        assert!(wants_last_video_frame(8.85, 8.90));
        assert!(wants_last_video_frame(8.90, 8.90));
        assert!(!wants_last_video_frame(8.70, 8.90));
        assert!(!wants_last_video_frame(0.0, 8.90));
        // Looped 9s source on a longer clip — last visible is mid-file.
        assert!(!wants_last_video_frame(7.55, 9.0));
    }

    #[test]
    fn last_frame_when_container_outlasts_video() {
        let Some(ffmpeg) = resolve_ffmpeg() else {
            return;
        };
        let dir = temp_dir();
        let source = dir.join("padded.mp4");
        if let Err(err) = write_padded_video(&ffmpeg, &source) {
            let _ = fs::remove_dir_all(&dir);
            panic!("{err}");
        }
        let duration = probe_duration(&ffmpeg, &source);
        assert!(
            duration > 0.7,
            "expected padded container duration, got {duration:.2}s"
        );

        let dest = dir.join("last.jpg");
        extract_video_jpeg(
            &ffmpeg,
            &source,
            &dest,
            duration - 0.05,
            duration,
            "format=yuvj420p",
        )
        .expect("last-frame extract at duration-0.05");
        assert!(jpeg_has_bytes(&dest), "expected a real last-frame JPEG");

        let dest_eof = dir.join("sentinel.jpg");
        extract_video_jpeg(
            &ffmpeg,
            &source,
            &dest_eof,
            1.0e9,
            duration,
            "format=yuvj420p",
        )
        .expect("last-frame extract via sentinel");
        assert!(jpeg_has_bytes(&dest_eof));

        // Mid-stream time (trimmed last-visible analog) must not require EOF.
        let dest_mid = dir.join("mid.jpg");
        extract_video_jpeg(
            &ffmpeg,
            &source,
            &dest_mid,
            0.25,
            duration,
            "format=yuvj420p",
        )
        .expect("mid-file extract at 0.25s");
        assert!(jpeg_has_bytes(&dest_mid));

        let _ = fs::remove_dir_all(&dir);
    }
}
