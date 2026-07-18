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

const ALGO_VERSION: &str = "v4";
const SAMPLE_RATE: u32 = 22_050;
const WINDOW: usize = 1024;
const HOP: usize = 512;
const MIN_GAP_SEC: f64 = 0.12;
/// Plausible musical tempo range for the beat grid.
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Default snap: a grid beat hugs a real onset within this fraction of a beat.
const SNAP_FRACTION: f64 = 0.25;
/// Default local onset rate (onsets per beat) above which a region counts as a
/// fast drum passage / fill and every onset there becomes an extra cut.
const DENSE_ONSETS_PER_BEAT: f64 = 3.0;
/// Default onset peak threshold in standard deviations above the local mean.
const ONSET_STD_MULT: f32 = 1.5;
/// Coarse RMS energy envelope hop (~46 ms at 22 kHz) for loudness contour.
const ENERGY_HOP: usize = 1024;

/// Neutral sensitivity (0..1) reproducing the default constants above.
pub const DEFAULT_SENSITIVITY: f64 = 0.5;

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// Spark Cut: higher sensitivity lowers the onset threshold, so more (subtler)
/// transients survive. 0 -> 2.4 (sparse), 0.5 -> 1.5 (default), 1 -> 0.6 (busy).
fn classic_threshold_mult(sensitivity: f64) -> f32 {
    (2.4 - 1.8 * clamp01(sensitivity)) as f32
}

/// Pulse Grid: higher sensitivity loosens snap so beats hug real onsets more.
/// 0 -> 0.05 (strict metronome), 0.5 -> 0.25 (default), 1 -> 0.45 (organic).
fn grid_snap_fraction(sensitivity: f64) -> f64 {
    0.05 + 0.4 * clamp01(sensitivity)
}

/// Drumfire: higher sensitivity lowers the fill threshold so more passages
/// subdivide. 0 -> 4.5 (frantic only), 0.5 -> 3.0 (default), 1 -> 1.5 (eager).
fn drum_dense_threshold(sensitivity: f64) -> f64 {
    4.5 - 3.0 * clamp01(sensitivity)
}

fn frames_per_sec() -> f64 {
    SAMPLE_RATE as f64 / HOP as f64
}

fn frame_to_sec(frame: f64) -> f64 {
    frame * HOP as f64 / SAMPLE_RATE as f64
}

fn energy_hz() -> f64 {
    SAMPLE_RATE as f64 / ENERGY_HOP as f64
}

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
    /// Cached spectral-flux onset envelope (one value per STFT hop). All beat
    /// algorithms derive their cut lists from this cheaply, so sensitivity can
    /// vary per clip without re-decoding the audio.
    flux: Vec<f32>,
    #[serde(default)]
    energy: Vec<f32>,
    #[serde(default)]
    energy_hz: f64,
}

impl BeatCache {
    /// Cut times for a slideshow mode at the given sensitivity (0..1).
    fn cuts_for_mode(&self, mode: &str, sensitivity: f64) -> Vec<f64> {
        match mode.trim().to_ascii_lowercase().as_str() {
            "beat_classic" => onset_times(&self.flux, classic_threshold_mult(sensitivity)),
            "beat_grid" => beat_grid_from_flux(&self.flux, grid_snap_fraction(sensitivity), None),
            "beat_drums" => beat_grid_from_flux(
                &self.flux,
                SNAP_FRACTION,
                Some(drum_dense_threshold(sensitivity)),
            ),
            // Color Current + legacy `beat` cut on the full grid; their
            // sensitivity is applied as image match strength, not cut timing.
            _ => beat_grid_from_flux(&self.flux, SNAP_FRACTION, Some(DENSE_ONSETS_PER_BEAT)),
        }
    }
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

/// Spectral-flux onset-strength envelope (one value per STFT hop).
fn onset_envelope(samples: &[f32]) -> Vec<f32> {
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
    flux
}

/// Adaptive-threshold onset peak frames from an onset-strength envelope.
/// `std_mult` controls sensitivity: lower keeps more (subtler) peaks.
fn pick_onset_frames(flux: &[f32], std_mult: f32) -> Vec<usize> {
    let mut peaks = Vec::new();
    if flux.is_empty() {
        return peaks;
    }
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
        let threshold = mean + std_mult * std;
        let is_local_max = (i == 0 || flux[i] >= flux[i - 1])
            && (i + 1 >= flux.len() || flux[i] >= flux[i + 1]);
        if is_local_max && flux[i] > threshold && flux[i] > 1e-4 {
            if let Some(prev) = last_peak {
                if i - prev < min_gap_frames {
                    continue;
                }
            }
            peaks.push(i);
            last_peak = Some(i);
        }
    }
    peaks
}

/// Log-tempo preference weight (~120 BPM center) to curb octave errors.
fn tempo_pref(bpm: f64) -> f32 {
    let center = 120.0_f64.ln();
    let sigma = 0.9;
    let x = bpm.ln();
    (-(x - center).powi(2) / (2.0 * sigma * sigma)).exp() as f32
}

/// Estimate the beat period (in envelope frames) via autocorrelation of the
/// onset envelope, biased toward mid tempos to avoid half/double-time errors.
fn estimate_period_frames(flux: &[f32]) -> Option<f64> {
    let fps = frames_per_sec();
    let min_lag = (60.0 / MAX_BPM * fps).floor().max(2.0) as usize;
    let max_lag = (60.0 / MIN_BPM * fps).ceil() as usize;
    if flux.len() < max_lag * 2 || max_lag <= min_lag {
        return None;
    }
    let mean = flux.iter().sum::<f32>() / flux.len() as f32;
    let dev: Vec<f32> = flux.iter().map(|v| v - mean).collect();

    let mut best_lag = 0usize;
    let mut best_score = f32::MIN;
    let mut scores = vec![0.0_f32; max_lag + 1];
    for lag in min_lag..=max_lag {
        let mut acc = 0.0_f32;
        for i in lag..dev.len() {
            acc += dev[i] * dev[i - lag];
        }
        let count = (dev.len() - lag) as f32;
        let bpm = 60.0 * fps / lag as f64;
        let score = (acc / count) * tempo_pref(bpm);
        scores[lag] = score;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best_score <= 0.0 {
        return None;
    }
    // Parabolic interpolation around the peak for sub-frame precision.
    if best_lag > min_lag && best_lag < max_lag {
        let a = scores[best_lag - 1];
        let b = scores[best_lag];
        let c = scores[best_lag + 1];
        let denom = a - 2.0 * b + c;
        if denom.abs() > f32::EPSILON {
            let delta = 0.5 * (a - c) / denom;
            if delta.abs() < 1.0 {
                return Some(best_lag as f64 + delta as f64);
            }
        }
    }
    Some(best_lag as f64)
}

/// Best whole-frame phase offset in [0, period) that lands the grid on energy.
fn estimate_phase(flux: &[f32], period: f64) -> f64 {
    let steps = period.round().max(1.0) as usize;
    let mut best_phase = 0.0;
    let mut best = f32::MIN;
    for s in 0..steps {
        let phi = s as f64;
        let mut acc = 0.0_f32;
        let mut k = 0.0;
        loop {
            let idx = (phi + k * period).round();
            if idx < 0.0 || idx as usize >= flux.len() {
                break;
            }
            acc += flux[idx as usize];
            k += 1.0;
        }
        if acc > best {
            best = acc;
            best_phase = phi;
        }
    }
    best_phase
}

fn onset_times(flux: &[f32], std_mult: f32) -> Vec<f64> {
    pick_onset_frames(flux, std_mult)
        .iter()
        .map(|&i| frame_to_sec(i as f64))
        .collect()
}

/// Tempo-locked beat grid, optionally augmented with dense drum/fill onsets.
/// `snap_fraction` controls how far grid beats slide to hug real onsets; a
/// `Some(threshold)` for `dense_per_beat` adds fast-passage subdivision cuts.
/// Falls back to original spectral-flux onset cuts when tempo is unstable.
fn beat_grid_from_flux(flux: &[f32], snap_fraction: f64, dense_per_beat: Option<f64>) -> Vec<f64> {
    let onset_frames = pick_onset_frames(flux, ONSET_STD_MULT);

    let period = match estimate_period_frames(flux) {
        Some(p) if p > 0.0 => p,
        _ => {
            return onset_frames
                .iter()
                .map(|&i| frame_to_sec(i as f64))
                .collect();
        }
    };
    let phase = estimate_phase(flux, period);
    let onset_f: Vec<f64> = onset_frames.iter().map(|&i| i as f64).collect();
    let snap_tol = period * snap_fraction;

    let mut beats = Vec::new();
    let mut k = 0.0;
    loop {
        let grid = phase + k * period;
        if grid >= flux.len() as f64 {
            break;
        }
        let mut t = grid;
        let mut best_d = snap_tol;
        for &o in &onset_f {
            let d = (o - grid).abs();
            if d < best_d {
                best_d = d;
                t = o;
            }
        }
        beats.push(frame_to_sec(t));
        k += 1.0;
    }

    if let Some(threshold) = dense_per_beat {
        // During fast drum passages (fills, double-time), cut on every onset so
        // imagery flips with the flurry instead of holding on the pulse.
        for &f in &dense_activity_onsets(&onset_frames, period, threshold) {
            beats.push(frame_to_sec(f as f64));
        }
    }

    beats.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    beats.dedup_by(|a, b| (*a - *b).abs() < MIN_GAP_SEC);
    beats
}

/// Onset frames sitting inside a locally dense cluster (more than
/// `per_beat_threshold` onsets per beat within a ±1 beat window). These mark
/// drum fills / fast sections where cuts should subdivide the pulse.
/// `onsets` must be sorted ascending (as produced by `pick_onset_frames`).
fn dense_activity_onsets(onsets: &[usize], period: f64, per_beat_threshold: f64) -> Vec<usize> {
    let n = onsets.len();
    if n < 3 || period <= 0.0 {
        return Vec::new();
    }
    let win = period; // one beat on each side -> 2-beat window
    let mut out = Vec::new();
    let mut lo = 0usize;
    let mut hi = 0usize;
    for j in 0..n {
        let center = onsets[j] as f64;
        while (center - onsets[lo] as f64) > win {
            lo += 1;
        }
        while hi + 1 < n && (onsets[hi + 1] as f64 - center) <= win {
            hi += 1;
        }
        let count = hi - lo + 1;
        // window spans ~2 beats, so onsets-per-beat = count / 2.
        if (count as f64) / 2.0 >= per_beat_threshold {
            out.push(onsets[j]);
        }
    }
    out
}

/// Coarse RMS energy envelope (one sample per `ENERGY_HOP` samples), used to
/// match image visual energy to the loudness contour of the music.
pub fn energy_envelope(samples: &[f32]) -> Vec<f32> {
    let hop = ENERGY_HOP.max(1);
    let mut out = Vec::with_capacity(samples.len() / hop + 1);
    let mut i = 0;
    while i < samples.len() {
        let end = (i + hop).min(samples.len());
        let mut acc = 0.0f64;
        for &s in &samples[i..end] {
            acc += (s as f64) * (s as f64);
        }
        let rms = (acc / (end - i) as f64).sqrt() as f32;
        out.push(rms);
        i += hop;
    }
    out
}

fn analyze_file(ffmpeg: &Path, src: &Path) -> Result<BeatCache, String> {
    let samples = decode_mono_f32(ffmpeg, src)?;
    Ok(BeatCache {
        algo_version: ALGO_VERSION.into(),
        flux: onset_envelope(&samples),
        energy: energy_envelope(&samples),
        energy_hz: energy_hz(),
    })
}

fn read_cache(path: &Path) -> Option<BeatCache> {
    let raw = fs::read_to_string(path).ok()?;
    let cache: BeatCache = serde_json::from_str(&raw).ok()?;
    if cache.algo_version != ALGO_VERSION {
        return None;
    }
    Some(cache)
}

fn write_cache(path: &Path, cache: &BeatCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Could not create beats cache: {e}"))?;
    }
    let raw = serde_json::to_string(cache).map_err(|e| format!("Could not serialize beats: {e}"))?;
    let temp = path.with_extension("json.partial");
    fs::write(&temp, raw).map_err(|e| format!("Could not write beats cache: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("Could not publish beats cache: {e}"))
}

fn ensure_cache(paths: &ParascenePaths, asset_id: &str) -> Result<BeatCache, String> {
    let id = asset_id.trim();
    if id.is_empty() {
        return Err("Missing audio asset id".into());
    }
    let gate = gate_for_asset(id);
    let _lock = gate.lock().unwrap_or_else(|e| e.into_inner());

    let dest = cache_path(paths, id);
    if let Some(cache) = read_cache(&dest) {
        return Ok(cache);
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
    let cache = analyze_file(&ffmpeg, &src)?;
    let _ = write_cache(&dest, &cache);
    Ok(cache)
}

pub fn ensure_beats(paths: &ParascenePaths, asset_id: &str) -> Result<Vec<f64>, String> {
    let cache = ensure_cache(paths, asset_id)?;
    Ok(cache.cuts_for_mode("beat_energy", DEFAULT_SENSITIVITY))
}

/// Cut times for a slideshow mode at the given sensitivity (0..1, `None` for
/// the neutral default). All modes derive from the cached onset envelope.
pub fn ensure_beats_for_mode(
    paths: &ParascenePaths,
    asset_id: &str,
    mode: &str,
    sensitivity: Option<f64>,
) -> Result<Vec<f64>, String> {
    let cache = ensure_cache(paths, asset_id)?;
    Ok(cache.cuts_for_mode(mode, sensitivity.unwrap_or(DEFAULT_SENSITIVITY)))
}

/// Cached coarse RMS loudness envelope for an audio asset, returned as
/// `(samples, samples_per_second)`. Sample at `t * hz` to read energy at time t.
pub fn ensure_energy(paths: &ParascenePaths, asset_id: &str) -> Result<(Vec<f32>, f64), String> {
    let cache = ensure_cache(paths, asset_id)?;
    let hz = if cache.energy_hz > 0.0 {
        cache.energy_hz
    } else {
        energy_hz()
    };
    Ok((cache.energy, hz))
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

    #[test]
    fn estimates_period_from_impulse_train() {
        // Impulse every 22 frames (~117 BPM at 22050/512 fps).
        let period = 22usize;
        let mut flux = vec![0.0_f32; 2000];
        let mut i = 0;
        while i < flux.len() {
            flux[i] = 1.0;
            i += period;
        }
        let est = estimate_period_frames(&flux).expect("tempo");
        assert!(
            (est - period as f64).abs() <= 1.0,
            "estimated {est}, expected ~{period}"
        );
    }

    #[test]
    fn estimates_phase_offset() {
        let period = 20usize;
        let offset = 5usize;
        let mut flux = vec![0.0_f32; 2000];
        let mut i = offset;
        while i < flux.len() {
            flux[i] = 1.0;
            i += period;
        }
        let phase = estimate_phase(&flux, period as f64);
        assert_eq!(phase, offset as f64);
    }

    #[test]
    fn snaps_grid_beats_to_nearby_onsets() {
        // Onsets a couple frames off a clean grid should pull the grid beats.
        let period = 22usize;
        let mut flux = vec![0.0_f32; 2000];
        let mut i = 2; // slight offset so onset picking has clear peaks
        while i < flux.len() {
            // small ramp so each spike is a strict local max above threshold
            flux[i] = 5.0;
            i += period;
        }
        let beats = detect_beats_from_flux_for_test(&flux);
        assert!(beats.len() > 10, "expected a full grid, got {}", beats.len());
        // Spacing should be close to the tempo period in seconds.
        let expected = frame_to_sec(period as f64);
        let gap = beats[5] - beats[4];
        assert!(
            (gap - expected).abs() < expected * 0.2,
            "gap {gap} vs expected {expected}"
        );
    }

    /// Test shim: run the grid builder directly on a synthetic envelope.
    fn detect_beats_from_flux_for_test(flux: &[f32]) -> Vec<f64> {
        beat_grid_from_flux(flux, SNAP_FRACTION, None)
    }

    #[test]
    fn sensitivity_maps_to_expected_dials() {
        assert!((classic_threshold_mult(DEFAULT_SENSITIVITY) - 1.5).abs() < 1e-6);
        assert!(classic_threshold_mult(1.0) < classic_threshold_mult(0.0));
        assert!((grid_snap_fraction(DEFAULT_SENSITIVITY) - 0.25).abs() < 1e-6);
        assert!(grid_snap_fraction(1.0) > grid_snap_fraction(0.0));
        assert!((drum_dense_threshold(DEFAULT_SENSITIVITY) - 3.0).abs() < 1e-6);
        assert!(drum_dense_threshold(1.0) < drum_dense_threshold(0.0));
    }

    #[test]
    fn higher_classic_sensitivity_keeps_more_onsets() {
        // Ramp of small bumps: subtle peaks only survive at high sensitivity.
        let mut flux = vec![0.0_f32; 600];
        for (i, v) in flux.iter_mut().enumerate() {
            *v = if i % 15 == 0 { 0.6 } else { 0.05 };
        }
        let sparse = onset_times(&flux, classic_threshold_mult(0.0));
        let busy = onset_times(&flux, classic_threshold_mult(1.0));
        assert!(
            busy.len() >= sparse.len(),
            "high sensitivity {} should keep >= low {}",
            busy.len(),
            sparse.len()
        );
    }

    #[test]
    fn dense_activity_flags_only_the_fast_cluster() {
        let period = 40.0;
        // Steady one-per-beat pulse: not dense.
        let mut onsets: Vec<usize> = (0..10).map(|k| (k as f64 * period) as usize).collect();
        // A fast fill (~5 per beat) packed into one beat near the end.
        let fill_start = 400usize;
        for j in 0..8 {
            onsets.push(fill_start + j * 8);
        }
        onsets.sort_unstable();
        onsets.dedup();

        let dense = dense_activity_onsets(&onsets, period, DENSE_ONSETS_PER_BEAT);
        assert!(!dense.is_empty(), "expected the fill to be flagged");
        // Everything flagged should live inside the fill window, not the pulse.
        for &f in &dense {
            assert!(
                (fill_start..=fill_start + 64).contains(&f),
                "unexpected dense onset {f} outside the fill"
            );
        }
    }

    #[test]
    fn energy_envelope_tracks_loudness() {
        let mut samples = vec![0.0_f32; ENERGY_HOP * 4];
        for s in samples.iter_mut().take(ENERGY_HOP * 2) {
            *s = 0.5;
        }
        let env = energy_envelope(&samples);
        assert_eq!(env.len(), 4);
        assert!(env[0] > 0.4 && env[1] > 0.4, "loud half should be high");
        assert!(env[3] < 0.01, "silent half should be near zero");
    }
}
