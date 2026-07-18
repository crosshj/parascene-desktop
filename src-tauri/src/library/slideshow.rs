//! Cached silent image-slideshow bakes for composite timeline clips.

use super::beats::{ensure_beats, map_beats_to_clip};
use super::catalog::{default_paths, get_creation_by_id, ready_connection};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_VERSION: &str = "v1";
const PREVIEW_STAGE_W: u32 = 1920;
const PREVIEW_STAGE_H: u32 = 1080;

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

fn fnv1a64(input: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in input.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn slideshow_gates() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate_for_key(key: &str) -> Arc<Mutex<()>> {
    let mut map = slideshow_gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.entry(key.to_string())
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

fn validate_cache_path(paths: &ParascenePaths, stored: &str) -> Result<PathBuf, String> {
    let path = Path::new(stored);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        paths.root.join(path)
    };
    let root_canon = paths
        .root
        .canonicalize()
        .map_err(|e| format!("Could not resolve library root: {e}"))?;
    let file_canon = candidate
        .canonicalize()
        .map_err(|e| format!("Slideshow bake missing or unreadable: {e}"))?;
    if !file_canon.starts_with(&root_canon) {
        return Err("Slideshow bake path is outside the Parascene library".into());
    }
    if !file_canon.starts_with(&paths.cache) {
        // Also allow when cache is under root but canonicalize differently.
        let cache_canon = paths.cache.canonicalize().unwrap_or(paths.cache.clone());
        if !file_canon.starts_with(&cache_canon) {
            return Err("Slideshow bake path is outside the Parascene cache".into());
        }
    }
    if !file_canon.is_file() {
        return Err("Slideshow bake file not found".into());
    }
    Ok(file_canon)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideshowEnsureInput {
    pub image_asset_ids: Vec<String>,
    pub mode: String,
    #[serde(default)]
    pub random: Option<bool>,
    #[serde(default)]
    pub seed: Option<u32>,
    pub duration_sec: f64,
    pub framing: Option<String>,
    pub aspect_ratio: String,
    /// Timeline start of the slideshow clip (for beat mapping).
    pub clip_start_sec: f64,
    pub audio_asset_id: Option<String>,
    pub audio_in_sec: Option<f64>,
    pub audio_out_sec: Option<f64>,
    pub audio_start_sec: Option<f64>,
    pub audio_end_sec: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlideshowEnsureResult {
    pub bake_key: String,
    pub path: String,
    pub duration_sec: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Framing {
    Fit,
    Fill,
    Stretch,
}

fn parse_framing(value: Option<&str>) -> Framing {
    match value.map(str::trim) {
        Some(v) if v.eq_ignore_ascii_case("fill") => Framing::Fill,
        Some(v) if v.eq_ignore_ascii_case("stretch") => Framing::Stretch,
        _ => Framing::Fit,
    }
}

fn output_size(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (1080, 1080),
        "9:16" => (1080, 1920),
        "4:5" => (1080, 1350),
        _ => (1920, 1080),
    }
}

fn aspect_parts(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (1, 1),
        "9:16" => (9, 16),
        "4:5" => (4, 5),
        _ => (16, 9),
    }
}

fn fit_inside(max_w: u32, max_h: u32, aw: u32, ah: u32) -> (u32, u32) {
    if aw == 0 || ah == 0 {
        return (max_w & !1, max_h & !1);
    }
    let mut w = max_w as u64;
    let mut h = w * ah as u64 / aw as u64;
    if h > max_h as u64 {
        h = max_h as u64;
        w = h * aw as u64 / ah as u64;
    }
    ((w as u32) & !1, (h as u32) & !1)
}

fn frame_filter(out_w: u32, out_h: u32, crop_w: u32, crop_h: u32, framing: Framing) -> String {
    let prefix = "setsar=1";
    let tail = "fps=30,format=yuv420p";
    match framing {
        Framing::Fit => format!(
            "{prefix},scale={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:force_original_aspect_ratio=decrease,pad={PREVIEW_STAGE_W}:{PREVIEW_STAGE_H}:(ow-iw)/2:(oh-ih)/2:black,crop={crop_w}:{crop_h}:(iw-{crop_w})/2:(ih-{crop_h})/2,scale={out_w}:{out_h},setsar=1,{tail}"
        ),
        Framing::Fill => format!(
            "{prefix},scale={out_w}:{out_h}:force_original_aspect_ratio=increase,crop={out_w}:{out_h},setsar=1,{tail}"
        ),
        Framing::Stretch => format!("{prefix},scale={out_w}:{out_h},setsar=1,{tail}"),
    }
}

fn push_x264_encode(args: &mut Vec<String>) {
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push("20".into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    args.push("-profile:v".into());
    args.push("baseline".into());
    args.push("-level".into());
    args.push("3.1".into());
    args.push("-bf".into());
    args.push("0".into());
    args.push("-x264-params".into());
    args.push(
        "keyint=30:min-keyint=30:scenecut=0:open-gop=0:repeat-headers=1:aud=1:cabac=0:8x8dct=0:weightp=0:weightb=0".into(),
    );
    args.push("-colorspace".into());
    args.push("bt709".into());
    args.push("-color_primaries".into());
    args.push("bt709".into());
    args.push("-color_trc".into());
    args.push("bt709".into());
    args.push("-color_range".into());
    args.push("tv".into());
    args.push("-movflags".into());
    args.push("+faststart".into());
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    let tail = err
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "ffmpeg slideshow failed (exit {}): {}",
        output.status,
        if tail.is_empty() {
            "unknown error".into()
        } else {
            tail
        }
    ))
}

fn concat_demixer_line(path: &Path) -> String {
    let s = path.display().to_string().replace('\'', "'\\''");
    format!("file '{s}'")
}

/// Build clip-local cut boundaries for a slideshow of `duration_sec`.
pub fn build_boundaries(
    mode: &str,
    duration_sec: f64,
    image_count: usize,
    beat_times_clip_local: &[f64],
) -> Result<Vec<f64>, String> {
    if image_count < 2 {
        return Err("Slideshow requires at least two images".into());
    }
    if !(duration_sec > 0.05) {
        return Err("Slideshow duration must be positive".into());
    }
    let mut cuts = vec![0.0];
    if mode.eq_ignore_ascii_case("beat") {
        for &t in beat_times_clip_local {
            if t > 0.05 && t < duration_sec - 0.05 {
                cuts.push(t);
            }
        }
    } else {
        let step = duration_sec / image_count as f64;
        for i in 1..image_count {
            cuts.push(step * i as f64);
        }
    }
    cuts.push(duration_sec);
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    cuts.dedup_by(|a, b| (*a - *b).abs() < 1e-4);
    if cuts.len() < 2 {
        return Err("Could not build slideshow spans".into());
    }
    Ok(cuts)
}

pub fn shuffled_indices(count: usize, seed: u32) -> Vec<usize> {
    let mut out: Vec<usize> = (0..count).collect();
    let mut state = if seed == 0 { 0x9e37_79b9 } else { seed };
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    for i in (1..out.len()).rev() {
        let j = next() as usize % (i + 1);
        out.swap(i, j);
    }
    out
}

pub fn bake_key_for(input: &SlideshowEnsureInput) -> String {
    let ids = input
        .image_asset_ids
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    let framing = input.framing.as_deref().unwrap_or("fit");
    let mode = input.mode.trim().to_ascii_lowercase();
    let random = input.random.unwrap_or(false);
    let payload = format!(
        "{CACHE_VERSION}|{ids}|{mode}|{}|{}|{:.3}|{framing}|{}|{}|{:.3}|{:.3}|{:.3}|{:.3}|{:.3}",
        if random { 1 } else { 0 },
        input.seed.unwrap_or(0),
        input.duration_sec,
        input.aspect_ratio.trim(),
        input.audio_asset_id.as_deref().unwrap_or(""),
        input.audio_in_sec.unwrap_or(0.0),
        input.audio_out_sec.unwrap_or(0.0),
        input.audio_start_sec.unwrap_or(0.0),
        input.audio_end_sec.unwrap_or(0.0),
        input.clip_start_sec,
    );
    format!("{}-{}", CACHE_VERSION, fnv1a64(&payload))
}

fn cache_dest(paths: &ParascenePaths, bake_key: &str) -> PathBuf {
    paths
        .cache
        .join("slideshows")
        .join(CACHE_VERSION)
        .join(format!("{}.mp4", safe_id(bake_key)))
}

fn resolve_image_paths(
    paths: &ParascenePaths,
    ids: &[String],
) -> Result<Vec<PathBuf>, String> {
    let conn = ready_connection(paths)?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        let creation = get_creation_by_id(&conn, trimmed)?
            .ok_or_else(|| format!("Creation not found: {trimmed}"))?;
        let local_path = creation
            .local_path
            .clone()
            .ok_or_else(|| format!("No local media on disk yet for {trimmed}"))?;
        out.push(path_under_root(&paths.root, &local_path)?);
    }
    if out.len() < 2 {
        return Err("Slideshow requires at least two local images".into());
    }
    Ok(out)
}

fn unique_partial(dest: &Path) -> PathBuf {
    // FFmpeg sniffs format from the *final* extension. Keep `.mp4` at the end:
    // `{stem}.mp4.partial.{pid}.{nanos}.mp4`
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let stem = dest
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("slideshow");
    let name = format!(
        "{stem}.partial.{}.{}.mp4",
        std::process::id(),
        nanos
    );
    dest.with_file_name(name)
}

fn encode_slideshow(
    paths: &ParascenePaths,
    input: &SlideshowEnsureInput,
    dest: &Path,
) -> Result<f64, String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to bake slideshows. Install with: brew install ffmpeg".to_string()
    })?;
    let image_ids: Vec<String> = input
        .image_asset_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut image_paths = resolve_image_paths(paths, &image_ids)?;
    let duration_sec = input.duration_sec.max(0.1);
    let mode = input.mode.trim().to_ascii_lowercase();
    if input.random.unwrap_or(false) {
        let order = shuffled_indices(image_paths.len(), input.seed.unwrap_or(0));
        image_paths = order
            .into_iter()
            .map(|index| image_paths[index].clone())
            .collect();
    }

    let beat_times = if mode == "beat" {
        let audio_id = input
            .audio_asset_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "Beat sync requires overlapping Master Audio on the timeline".to_string()
            })?;
        let audio_start = input.audio_start_sec.unwrap_or(0.0);
        let audio_end = input
            .audio_end_sec
            .unwrap_or(audio_start + duration_sec)
            .max(audio_start + 0.05);
        let audio_in = input.audio_in_sec.unwrap_or(0.0).max(0.0);
        let visual_start = input.clip_start_sec.max(0.0);
        let visual_end = visual_start + duration_sec;
        let source_beats = ensure_beats(paths, audio_id)?;
        let mapped = map_beats_to_clip(
            &source_beats,
            visual_start,
            visual_end,
            audio_start,
            audio_end,
            audio_in,
        );
        if mapped.is_empty() {
            return Err(
                "No beats found in the overlapping audio range for this slideshow".into(),
            );
        }
        mapped
    } else {
        Vec::new()
    };

    let boundaries = build_boundaries(&mode, duration_sec, image_paths.len(), &beat_times)?;
    let (width, height) = output_size(&input.aspect_ratio);
    let (aw, ah) = aspect_parts(&input.aspect_ratio);
    let (crop_w, crop_h) = fit_inside(PREVIEW_STAGE_W, PREVIEW_STAGE_H, aw, ah);
    let framing = parse_framing(input.framing.as_deref());
    let frame = frame_filter(width, height, crop_w, crop_h, framing);

    let work_dir = dest.with_extension("segments");
    if work_dir.exists() {
        let _ = fs::remove_dir_all(&work_dir);
    }
    fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Could not create slideshow workspace: {e}"))?;

    let mut segment_paths = Vec::new();
    for i in 0..boundaries.len() - 1 {
        let start = boundaries[i];
        let end = boundaries[i + 1];
        let seg_dur = (end - start).max(1.0 / 30.0);
        let image_path = &image_paths[i % image_paths.len()];
        let seg_path = work_dir.join(format!("seg_{i:03}.mp4"));
        let frames = (seg_dur * 30.0).round().max(1.0) as u32;
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-loop".into(),
            "1".into(),
            "-framerate".into(),
            "30".into(),
            "-t".into(),
            format!("{seg_dur:.3}"),
            "-i".into(),
            image_path.display().to_string(),
            "-vf".into(),
            format!("{frame},trim=duration={seg_dur:.3},setpts=PTS-STARTPTS"),
            "-fps_mode".into(),
            "cfr".into(),
            "-an".into(),
        ];
        push_x264_encode(&mut args);
        args.push("-frames:v".into());
        args.push(frames.to_string());
        args.push(seg_path.display().to_string());
        run_ffmpeg(&ffmpeg, &args)?;
        if !seg_path.is_file() {
            return Err(format!(
                "Slideshow segment encode produced no file: {}",
                seg_path.display()
            ));
        }
        segment_paths.push(seg_path);
    }

    let list_path = work_dir.join("concat.txt");
    let list_body = segment_paths
        .iter()
        .map(|p| concat_demixer_line(p))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&list_path, list_body + "\n")
        .map_err(|e| format!("Could not write slideshow concat list: {e}"))?;

    let partial = unique_partial(dest);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create slideshow cache dir: {e}"))?;
    }

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list_path.display().to_string(),
        "-map".into(),
        "0:v".into(),
        "-an".into(),
        "-fps_mode".into(),
        "cfr".into(),
        "-t".into(),
        format!("{duration_sec:.3}"),
    ];
    push_x264_encode(&mut args);
    args.push("-f".into());
    args.push("mp4".into());
    args.push(partial.display().to_string());
    run_ffmpeg(&ffmpeg, &args)?;
    if !partial.is_file() {
        return Err("Slideshow bake produced no output file".into());
    }
    fs::rename(&partial, dest).map_err(|e| format!("Could not publish slideshow bake: {e}"))?;
    let _ = fs::remove_dir_all(&work_dir);
    Ok(duration_sec)
}

pub fn ensure_slideshow(
    paths: &ParascenePaths,
    input: &SlideshowEnsureInput,
) -> Result<SlideshowEnsureResult, String> {
    let bake_key = bake_key_for(input);
    let gate = gate_for_key(&bake_key);
    let _lock = gate.lock().unwrap_or_else(|e| e.into_inner());
    let dest = cache_dest(paths, &bake_key);
    if dest.is_file() {
        if let Ok(valid) = validate_cache_path(paths, &dest.display().to_string()) {
            return Ok(SlideshowEnsureResult {
                bake_key,
                path: valid.display().to_string(),
                duration_sec: input.duration_sec.max(0.1),
            });
        }
        let _ = fs::remove_file(&dest);
    }
    let duration_sec = encode_slideshow(paths, input, &dest)?;
    let valid = validate_cache_path(paths, &dest.display().to_string())?;
    Ok(SlideshowEnsureResult {
        bake_key,
        path: valid.display().to_string(),
        duration_sec,
    })
}

#[tauri::command]
pub async fn library_ensure_slideshow(
    input: SlideshowEnsureInput,
) -> Result<SlideshowEnsureResult, String> {
    let paths = default_paths()?;
    tauri::async_runtime::spawn_blocking(move || ensure_slideshow(&paths, &input))
        .await
        .map_err(|e| format!("Slideshow bake task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn even_boundaries_split_evenly() {
        let cuts = build_boundaries("even", 10.0, 4, &[]).unwrap();
        assert_eq!(cuts, vec![0.0, 2.5, 5.0, 7.5, 10.0]);
    }

    #[test]
    fn beat_boundaries_include_start_end_and_beats() {
        let cuts = build_boundaries("beat", 10.0, 3, &[1.0, 4.0, 9.0]).unwrap();
        assert_eq!(cuts, vec![0.0, 1.0, 4.0, 9.0, 10.0]);
    }

    #[test]
    fn bake_key_stable_for_same_recipe() {
        let input = SlideshowEnsureInput {
            image_asset_ids: vec!["a".into(), "b".into()],
            mode: "even".into(),
            random: None,
            seed: None,
            duration_sec: 10.0,
            framing: Some("fit".into()),
            aspect_ratio: "9:16".into(),
            clip_start_sec: 0.0,
            audio_asset_id: None,
            audio_in_sec: None,
            audio_out_sec: None,
            audio_start_sec: None,
            audio_end_sec: None,
        };
        assert_eq!(bake_key_for(&input), bake_key_for(&input));
    }

    #[test]
    fn random_order_is_seeded_and_complete() {
        let a = shuffled_indices(12, 123);
        let b = shuffled_indices(12, 123);
        let c = shuffled_indices(12, 456);
        assert_eq!(a, b);
        assert_ne!(a, c);
        let mut sorted = a;
        sorted.sort_unstable();
        assert_eq!(sorted, (0..12).collect::<Vec<_>>());
    }
}
