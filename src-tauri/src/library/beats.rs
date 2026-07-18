//! Onset / beat detection for local audio assets via FFmpeg + spectral flux.

use super::catalog::{default_paths, get_creation_by_id, ready_connection};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

const ALGO_VERSION: &str = "v1";
const SAMPLE_RATE: u32 = 22_050;
const WINDOW: usize = 1024;
const HOP: usize = 512;
const MIN_GAP_SEC: f64 = 0.12;

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn beat_gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate_for_asset(id: &str) -> Arc<Mutex<()>> {
    let mut map = beat_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn path_under_root(root: &Path, stored: &str) -> Result<PathBuf, String> {
    let path = Path::new(stored);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Could not resolve library root: {e}"))?;
    let file_canon = candidate
        .canonicalize()
        .map_err(|e| format!("Local media missing or unreadable: {e}"))?;
    if !file_canon.starts_with(&root_canon) {
        return Err("Local media path is outside the Parascene library".into());
    }
    if !file_canon.is_file() {
        return Err("Local media file not found".into());
    }
    Ok(file_canon)
}

fn cache_path(paths: &ParascenePaths, asset_id: &str) -> PathBuf {
    paths
        .cache
        .join("beats")
        .join(ALGO_VERSION)
        .join(format!("{}.json", safe_id(asset_id)))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeatCache {
    algo_version: String,
    times: Vec<f64>,
}

fn decode_mono_f32(ffmpeg: &Path, src: &Path) -> Result<Vec<f32>, String> {
    let mut child = Command::new(ffmpeg)
        .args([
            "-v",
            "error",
            "-i",
            &src.display().to_string(),
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "f32le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run ffmpeg for beat decode: {e}"))?;

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
        .map_err(|e| format!("ffmpeg beat decode wait failed: {e}"))?;
    if !status.success() {
        return Err("ffmpeg beat decode failed".into());
    }
    if bytes.len() < 4 {
        return Err("Audio decode produced no samples".into());
    }
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(samples)
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / (n as f32 - 1.0).max(1.0);
            0.5 * (1.0 - x.cos())
        })
        .collect()
}

/// Spectral-flux onset peaks in seconds.
pub fn detect_onsets(samples: &[f32]) -> Vec<f64> {
    if samples.len() < WINDOW {
        return Vec::new();
    }
    let window = hann(WINDOW);
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(WINDOW);
    let mut prev_mag = vec![0.0_f32; WINDOW / 2 + 1];
    let mut flux = Vec::new();
    let mut frame = vec![Complex::new(0.0, 0.0); WINDOW];

    let mut offset = 0;
    while offset + WINDOW <= samples.len() {
        for i in 0..WINDOW {
            frame[i] = Complex::new(samples[offset + i] * window[i], 0.0);
        }
        fft.process(&mut frame);
        let mut sum = 0.0_f32;
        for i in 0..=WINDOW / 2 {
            let mag = frame[i].norm();
            let diff = mag - prev_mag[i];
            if diff > 0.0 {
                sum += diff;
            }
            prev_mag[i] = mag;
        }
        flux.push(sum);
        offset += HOP;
    }

    if flux.is_empty() {
        return Vec::new();
    }

    // Adaptive threshold: local mean + k * local std.
    let mut peaks = Vec::new();
    let radius = 8usize;
    let min_gap_frames = ((MIN_GAP_SEC * SAMPLE_RATE as f64) / HOP as f64).ceil() as usize;
    let mut last_peak: Option<usize> = None;
    for i in 0..flux.len() {
        let start = i.saturating_sub(radius);
        let end = (i + radius + 1).min(flux.len());
        let slice = &flux[start..end];
        let mean = slice.iter().sum::<f32>() / slice.len() as f32;
        let var = slice
            .iter()
            .map(|v| {
                let d = v - mean;
                d * d
            })
            .sum::<f32>()
            / slice.len() as f32;
        let std = var.sqrt();
        let threshold = mean + 1.5 * std;
        let is_local_max = (i == 0 || flux[i] >= flux[i - 1])
            && (i + 1 >= flux.len() || flux[i] >= flux[i + 1]);
        if is_local_max && flux[i] > threshold && flux[i] > 1e-4 {
            if let Some(prev) = last_peak {
                if i - prev < min_gap_frames {
                    continue;
                }
            }
            let t = (i as f64 * HOP as f64) / SAMPLE_RATE as f64;
            peaks.push(t);
            last_peak = Some(i);
        }
    }
    peaks
}

fn analyze_file(ffmpeg: &Path, src: &Path) -> Result<Vec<f64>, String> {
    let samples = decode_mono_f32(ffmpeg, src)?;
    Ok(detect_onsets(&samples))
}

fn read_cache(path: &Path) -> Option<Vec<f64>> {
    let raw = fs::read_to_string(path).ok()?;
    let cache: BeatCache = serde_json::from_str(&raw).ok()?;
    if cache.algo_version != ALGO_VERSION {
        return None;
    }
    Some(cache.times)
}

fn write_cache(path: &Path, times: &[f64]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create beats cache: {e}"))?;
    }
    let cache = BeatCache {
        algo_version: ALGO_VERSION.into(),
        times: times.to_vec(),
    };
    let raw = serde_json::to_string(&cache).map_err(|e| format!("Could not serialize beats: {e}"))?;
    let temp = path.with_extension("json.partial");
    fs::write(&temp, raw).map_err(|e| format!("Could not write beats cache: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("Could not publish beats cache: {e}"))
}

pub fn ensure_beats(paths: &ParascenePaths, asset_id: &str) -> Result<Vec<f64>, String> {
    let id = asset_id.trim();
    if id.is_empty() {
        return Err("Missing audio asset id".into());
    }
    let gate = gate_for_asset(id);
    let _lock = gate.lock().unwrap_or_else(|e| e.into_inner());

    let dest = cache_path(paths, id);
    if let Some(times) = read_cache(&dest) {
        return Ok(times);
    }

    let conn = ready_connection(paths)?;
    let creation = get_creation_by_id(&conn, id)?
        .ok_or_else(|| format!("Creation not found: {id}"))?;
    let local_path = creation
        .local_path
        .clone()
        .ok_or_else(|| format!("No local media on disk yet for {id}"))?;
    let src = path_under_root(&paths.root, &local_path)?;
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required for beat detection. Install with: brew install ffmpeg".to_string()
    })?;
    let times = analyze_file(&ffmpeg, &src)?;
    let _ = write_cache(&dest, &times);
    Ok(times)
}

/// Map absolute source-file beat times into a visual clip's local timeline.
///
/// `visual_start`/`visual_end` are timeline seconds for the slideshow clip.
/// `audio_start`/`audio_end` are timeline seconds for the overlapping audio clip.
/// `audio_in` is the audio source in-point corresponding to `audio_start`.
pub fn map_beats_to_clip(
    source_beats: &[f64],
    visual_start: f64,
    visual_end: f64,
    audio_start: f64,
    audio_end: f64,
    audio_in: f64,
) -> Vec<f64> {
    let overlap_start = visual_start.max(audio_start);
    let overlap_end = visual_end.min(audio_end);
    if !(overlap_end > overlap_start) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for &source_t in source_beats {
        let timeline_t = audio_start + (source_t - audio_in);
        if timeline_t > overlap_start + 1e-4 && timeline_t < overlap_end - 1e-4 {
            // Convert to clip-local time (0 at visual_start).
            out.push(timeline_t - visual_start);
        }
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    out
}

#[tauri::command]
pub async fn library_detect_beats(asset_id: String) -> Result<Vec<f64>, String> {
    let paths = default_paths()?;
    let id = asset_id;
    tauri::async_runtime::spawn_blocking(move || ensure_beats(&paths, &id))
        .await
        .map_err(|e| format!("Beat detection task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_beats_into_clip_local_time() {
        // Audio starts at t=5 with inSec=1. Visual clip 6..16.
        // Source beat at 3s → timeline 5+(3-1)=7 → clip-local 1.
        let mapped = map_beats_to_clip(&[1.0, 3.0, 12.0], 6.0, 16.0, 5.0, 20.0, 1.0);
        assert_eq!(mapped, vec![1.0]);
    }

    #[test]
    fn empty_when_no_overlap() {
        let mapped = map_beats_to_clip(&[1.0, 2.0], 0.0, 2.0, 5.0, 10.0, 0.0);
        assert!(mapped.is_empty());
    }
}
