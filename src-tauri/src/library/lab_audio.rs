//! Lab audio/video helpers: full-track vocals separate, time-slice, extend clips.

use super::catalog::default_paths;
use super::ffmpeg::resolve_ffmpeg;
use super::lab_deps::resolve_demucs;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeaksResult {
    peaks: Vec<f32>,
    duration_sec: f64,
}

fn cache_dir(kind: &str) -> Result<PathBuf, String> {
    let paths = default_paths()?;
    let dir = paths.cache.join("lab").join(kind);
    fs::create_dir_all(&dir).map_err(|e| format!("Could not create lab cache: {e}"))?;
    Ok(dir)
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "ffmpeg failed (exit {}): {}",
        output.status,
        stderr.chars().take(400).collect::<String>()
    ))
}

fn hash_key(parts: &[&str]) -> String {
    let mut hasher = DefaultHasher::new();
    for p in parts {
        p.hash(&mut hasher);
    }
    format!("{:016x}", hasher.finish())
}

fn source_fingerprint(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Could not stat source: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(hash_key(&[
        path.to_str().unwrap_or(""),
        &meta.len().to_string(),
        &modified.to_string(),
    ]))
}

/// Normalize any local audio/video to a stereo 44.1kHz WAV (cached).
fn ensure_full_mix_wav(ffmpeg: &Path, source: &Path) -> Result<PathBuf, String> {
    let key = source_fingerprint(source)?;
    let dir = cache_dir("audio")?;
    let dest = dir.join(format!("{key}.full-mix.wav"));
    if dest.is_file() {
        return Ok(dest);
    }
    let tmp = dir.join(format!("{key}.full-mix.tmp.wav"));
    let _ = fs::remove_file(&tmp);
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            source.to_str().ok_or("Invalid source path")?,
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "44100",
            "-ac",
            "2",
            tmp.to_str().ok_or("Invalid temp path")?,
        ],
    )?;
    fs::rename(&tmp, &dest).map_err(|e| format!("Could not finalize full mix: {e}"))?;
    Ok(dest)
}

/// Cached full-track vocals stem for a source file, if already separated.
pub fn cached_full_vocals_path(source: &Path) -> Result<Option<PathBuf>, String> {
    if !source.is_file() {
        return Ok(None);
    }
    let key = source_fingerprint(source)?;
    let dir = cache_dir("audio")?;
    let vocals_path = dir.join(format!("{key}.full-vocals.wav"));
    if vocals_path.is_file() {
        Ok(Some(vocals_path))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn library_cached_full_vocals(source_path: String) -> Result<Option<String>, String> {
    let src = PathBuf::from(&source_path);
    Ok(cached_full_vocals_path(&src)?
        .map(|p| p.display().to_string()))
}

/// Run Demucs on the **full** mix once; cache `{fingerprint}.full-vocals.wav`.
#[tauri::command]
pub async fn library_separate_vocals(source_path: String) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err("Source audio file not found".into());
    }
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required. Install with: brew install ffmpeg".to_string()
    })?;
    let demucs_bin = resolve_demucs().ok_or_else(|| {
        "demucs not found — install via Settings → Local tools, or see LOCAL_TOOLS.md".to_string()
    })?;

    let key = source_fingerprint(&src)?;
    let dir = cache_dir("audio")?;
    let vocals_path = dir.join(format!("{key}.full-vocals.wav"));
    if vocals_path.is_file() {
        return Ok(vocals_path.to_string_lossy().to_string());
    }

    let mix = ensure_full_mix_wav(&ffmpeg, &src)?;
    let out_dir = dir.join(format!("{key}.demucs-full"));
    let _ = fs::remove_dir_all(&out_dir);
    fs::create_dir_all(&out_dir).map_err(|e| format!("demucs out dir: {e}"))?;

    let status = Command::new(&demucs_bin)
        .args([
            "-n",
            "htdemucs",
            "--two-stems",
            "vocals",
            "-o",
            out_dir.to_str().ok_or("Invalid demucs out")?,
            mix.to_str().ok_or("Invalid mix path")?,
        ])
        .status()
        .map_err(|e| format!("Could not run demucs: {e}"))?;
    if !status.success() {
        return Err(format!("demucs failed (exit {status})"));
    }

    let vocals_found = find_vocals_wav(&out_dir)?;
    let tmp = dir.join(format!("{key}.full-vocals.tmp.wav"));
    let _ = fs::remove_file(&tmp);
    fs::copy(&vocals_found, &tmp).map_err(|e| format!("Could not copy vocals: {e}"))?;
    fs::rename(&tmp, &vocals_path).map_err(|e| format!("Could not finalize vocals: {e}"))?;
    Ok(vocals_path.to_string_lossy().to_string())
}

/// Slice `[inSec, outSec)` from a local audio/video file to a WAV under Lab cache.
#[tauri::command]
pub async fn library_slice_audio(
    source_path: String,
    in_sec: f64,
    out_sec: f64,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err("Source audio file not found".into());
    }
    if !(out_sec > in_sec) {
        return Err("outSec must be greater than inSec".into());
    }
    let dur = out_sec - in_sec;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required. Install with: brew install ffmpeg".to_string()
    })?;

    let key = hash_key(&[
        &source_path,
        &format!("{in_sec:.3}"),
        &format!("{out_sec:.3}"),
        "slice",
    ]);
    let dir = cache_dir("audio")?;
    let slice_path = dir.join(format!("{key}.slice.wav"));

    if slice_path.is_file() {
        return Ok(slice_path.to_string_lossy().to_string());
    }

    let tmp = dir.join(format!("{key}.slice.tmp.wav"));
    let _ = fs::remove_file(&tmp);
    run_ffmpeg(
        &ffmpeg,
        &[
            "-y",
            "-ss",
            &format!("{in_sec:.3}"),
            "-t",
            &format!("{dur:.3}"),
            "-i",
            src.to_str().ok_or("Invalid source path")?,
            "-vn",
            "-acodec",
            "pcm_s16le",
            "-ar",
            "44100",
            "-ac",
            "2",
            tmp.to_str().ok_or("Invalid temp path")?,
        ],
    )?;
    fs::rename(&tmp, &slice_path).map_err(|e| format!("Could not finalize slice: {e}"))?;
    Ok(slice_path.to_string_lossy().to_string())
}

/// Peak envelope for Lab waveforms (0..1 per bucket).
#[tauri::command]
pub async fn library_audio_waveform_peaks(
    path: String,
    buckets: Option<u32>,
) -> Result<WaveformPeaksResult, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err("Audio file not found".into());
    }
    let n = buckets.unwrap_or(128).clamp(16, 512) as usize;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required. Install with: brew install ffmpeg".to_string()
    })?;

    let path_owned = src;
    let result =
        tokio::task::spawn_blocking(move || decode_peak_buckets(&ffmpeg, &path_owned, n))
            .await
            .map_err(|e| format!("Waveform task failed: {e}"))??;
    Ok(result)
}

fn decode_peak_buckets(
    ffmpeg: &Path,
    src: &Path,
    buckets: usize,
) -> Result<WaveformPeaksResult, String> {
    let mut child = Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            &src.display().to_string(),
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "f32le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg for waveform: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout missing".to_string())?;
    let mut bytes = Vec::new();
    stdout
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read ffmpeg PCM: {e}"))?;
    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg waveform wait failed: {e}"))?;
    if !status.success() {
        return Err("ffmpeg waveform decode failed".into());
    }
    if bytes.len() < 4 {
        return Err("Audio decode produced no samples".into());
    }

    let sample_count = bytes.len() / 4;
    const PCM_SAMPLE_RATE: f64 = 8000.0;
    let duration_sec = sample_count as f64 / PCM_SAMPLE_RATE;
    let mut peaks = vec![0.0f32; buckets];
    for (i, chunk) in bytes.chunks_exact(4).enumerate() {
        let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]).abs();
        let bucket = (i * buckets) / sample_count.max(1);
        if bucket < buckets {
            peaks[bucket] = peaks[bucket].max(sample);
        }
    }
    let max = peaks.iter().copied().fold(0.0f32, f32::max).max(1e-6);
    for p in &mut peaks {
        *p /= max;
    }
    Ok(WaveformPeaksResult {
        peaks,
        duration_sec,
    })
}

fn find_vocals_wav(root: &Path) -> Result<PathBuf, String> {
    fn walk(dir: &Path, depth: usize) -> Option<PathBuf> {
        if depth > 6 {
            return None;
        }
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, depth + 1) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("vocals.wav"))
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
        None
    }
    walk(root, 0).ok_or_else(|| "demucs output vocals.wav not found".into())
}

/// Extend a short clip to `target_sec` via loop / ping-pong / trim-loop.
#[tauri::command]
pub async fn library_extend_clip(
    source_path: String,
    mode: String,
    target_sec: f64,
    in_sec: Option<f64>,
    out_sec: Option<f64>,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err("Source media file not found".into());
    }
    if !(target_sec > 0.1) {
        return Err("targetSec must be > 0.1".into());
    }
    let mode = mode.trim().to_ascii_lowercase();
    if !matches!(mode.as_str(), "loop" | "pingpong" | "trimloop") {
        return Err("mode must be loop, pingPong, or trimLoop".into());
    }
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required. Install with: brew install ffmpeg".to_string()
    })?;

    let in_s = in_sec.unwrap_or(0.0).max(0.0);
    let out_s = out_sec;
    let key = hash_key(&[
        &source_path,
        &mode,
        &format!("{target_sec:.3}"),
        &format!("{in_s:.3}"),
        &format!("{:.3}", out_s.unwrap_or(-1.0)),
    ]);
    let dir = cache_dir("extend")?;
    let dest = dir.join(format!("{key}.mp4"));
    if dest.is_file() {
        return Ok(dest.to_string_lossy().to_string());
    }

    let segment = dir.join(format!("{key}.seg.mp4"));
    {
        let tmp = dir.join(format!("{key}.seg.tmp.mp4"));
        let _ = fs::remove_file(&tmp);
        let mut args: Vec<String> = vec!["-y".into()];
        if in_s > 0.0 {
            args.push("-ss".into());
            args.push(format!("{in_s:.3}"));
        }
        args.push("-i".into());
        args.push(src.to_string_lossy().to_string());
        if let Some(o) = out_s {
            if o > in_s {
                args.push("-t".into());
                args.push(format!("{:.3}", o - in_s));
            }
        }
        args.extend([
            "-an".into(),
            "-c:v".into(),
            "libx264".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            tmp.to_string_lossy().to_string(),
        ]);
        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        run_ffmpeg(&ffmpeg, &arg_refs)?;
        fs::rename(&tmp, &segment).map_err(|e| format!("segment rename: {e}"))?;
    }

    let probe = Command::new(&ffmpeg)
        .args(["-i", segment.to_str().unwrap_or(""), "-f", "null", "-"])
        .output()
        .map_err(|e| format!("probe failed: {e}"))?;
    let stderr = String::from_utf8_lossy(&probe.stderr);
    let seg_dur = parse_duration_from_ffmpeg_stderr(&stderr)
        .unwrap_or(1.0)
        .max(0.1);

    let reverse = dir.join(format!("{key}.rev.mp4"));
    if matches!(mode.as_str(), "pingpong") && !reverse.is_file() {
        let tmp = dir.join(format!("{key}.rev.tmp.mp4"));
        run_ffmpeg(
            &ffmpeg,
            &[
                "-y",
                "-i",
                segment.to_str().ok_or("bad seg")?,
                "-an",
                "-vf",
                "reverse",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                tmp.to_str().ok_or("bad tmp")?,
            ],
        )?;
        fs::rename(&tmp, &reverse).map_err(|e| format!("reverse rename: {e}"))?;
    }

    let unit = match mode.as_str() {
        "pingpong" => seg_dur * 2.0,
        _ => seg_dur,
    };
    let loops = ((target_sec / unit).ceil() as usize).max(1);

    let list = dir.join(format!("{key}.txt"));
    {
        let mut body = String::new();
        for _ in 0..loops {
            body.push_str(&format!(
                "file '{}'\n",
                segment.to_string_lossy().replace('\'', "'\\''")
            ));
            if mode == "pingpong" {
                body.push_str(&format!(
                    "file '{}'\n",
                    reverse.to_string_lossy().replace('\'', "'\\''")
                ));
            }
        }
        fs::write(&list, body).map_err(|e| format!("concat list: {e}"))?;
    }

    let tmp = dir.join(format!("{key}.out.tmp.mp4"));
    let _ = fs::remove_file(&tmp);
    run_ffmpeg(
        &ffmpeg,
        &[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            list.to_str().ok_or("bad list")?,
            "-t",
            &format!("{target_sec:.3}"),
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            tmp.to_str().ok_or("bad out")?,
        ],
    )?;
    fs::rename(&tmp, &dest).map_err(|e| format!("extend rename: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Read a local file as base64 (Lab uploads, e.g. vocals slice for a2v).
#[tauri::command]
pub fn library_read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("File not found".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("Could not read file: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn parse_duration_from_ffmpeg_stderr(stderr: &str) -> Option<f64> {
    let idx = stderr.find("Duration:")?;
    let slice = &stderr[idx + "Duration:".len()..];
    let time = slice.split(',').next()?.trim();
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}
