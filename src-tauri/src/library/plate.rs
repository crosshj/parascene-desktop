//! Local plate still bake — side-by-side layout into one high-res image.
//!
//! Default placement: each image fills the canvas height (keeps aspect),
//! left→right in order; remaining horizontal space becomes the automatic gap.

use super::catalog::{default_paths, get_creation_by_id, ready_connection};
use super::ffmpeg::{self, resolve_ffmpeg};
use super::paths::ParascenePaths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateBakeInput {
    pub image_asset_ids: Vec<String>,
    /// Output aspect, e.g. "1:1", "16:9", "9:16".
    pub aspect_ratio: String,
    /// Longest edge in pixels (default 2048). Short edge follows aspect.
    #[serde(default)]
    pub resolution: Option<u32>,
    /// equal_columns | height_fill (default height_fill).
    #[serde(default)]
    pub placement: Option<String>,
    /// Per-slot framing for equal_columns: fit | fill | stretch.
    #[serde(default)]
    pub framing: Option<String>,
    /// auto | fixed (default auto for height_fill).
    #[serde(default)]
    pub gap_mode: Option<String>,
    /// Gap between slots when gap_mode is fixed.
    #[serde(default)]
    pub gap_px: Option<u32>,
    /// Outer margin around the row in pixels (default 0).
    #[serde(default)]
    pub margin_px: Option<u32>,
    /// When true, write a unique preview cache file (do not import).
    #[serde(default)]
    pub preview: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlateBakeResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// Actual gap used (px) after auto layout.
    pub gap_px: u32,
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

fn resolve_image_paths(paths: &ParascenePaths, ids: &[String]) -> Result<Vec<PathBuf>, String> {
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
        return Err("Plate bake requires at least two local images".into());
    }
    Ok(out)
}

fn aspect_parts(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio.trim() {
        "1:1" => (1, 1),
        "9:16" => (9, 16),
        "4:5" => (4, 5),
        "3:4" => (3, 4),
        "4:3" => (4, 3),
        _ => (16, 9),
    }
}

fn output_size(aspect_ratio: &str, long_edge: u32) -> (u32, u32) {
    let long = long_edge.max(256).min(8192) & !1;
    let (aw, ah) = aspect_parts(aspect_ratio);
    if aw >= ah {
        let w = long;
        let h = ((long as u64 * ah as u64) / aw as u64) as u32 & !1;
        (w, h.max(2))
    } else {
        let h = long;
        let w = ((long as u64 * aw as u64) / ah as u64) as u32 & !1;
        (w.max(2), h)
    }
}

fn slot_scale_filter(slot_w: u32, slot_h: u32, framing: &str) -> String {
    match framing {
        "fill" => format!(
            "scale={slot_w}:{slot_h}:force_original_aspect_ratio=increase,crop={slot_w}:{slot_h},setsar=1,format=rgba"
        ),
        "stretch" => format!("scale={slot_w}:{slot_h},setsar=1,format=rgba"),
        _ => format!(
            "scale={slot_w}:{slot_h}:force_original_aspect_ratio=decrease,pad={slot_w}:{slot_h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgba"
        ),
    }
}

fn probe_dims(path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(path).map_err(|e| format!("Could not read image size: {e}"))
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str]) -> Result<(), String> {
    let output = ffmpeg::command(ffmpeg)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail = stderr
        .lines()
        .rev()
        .take(16)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "ffmpeg plate bake failed (exit {}): {}",
        output.status,
        if tail.is_empty() {
            "unknown error".into()
        } else {
            tail
        }
    ))
}

struct PlacedSlot {
    x: u32,
    y: u32,
    scale_filter: String,
}

/// Height-fill: each image fills content height, keeps aspect; leftover width
/// is the automatic gap (or fixed gap with uniform shrink if needed).
fn layout_height_fill(
    images: &[PathBuf],
    content_w: u32,
    content_h: u32,
    margin: u32,
    gap_mode: &str,
    fixed_gap: u32,
) -> Result<(Vec<PlacedSlot>, u32), String> {
    let n = images.len() as u32;
    let mut natural_w: Vec<f64> = Vec::with_capacity(images.len());
    for path in images {
        let (iw, ih) = probe_dims(path)?;
        if iw == 0 || ih == 0 {
            return Err("Image has zero dimensions".into());
        }
        let w = (content_h as f64) * (iw as f64) / (ih as f64);
        natural_w.push(w);
    }
    let sum_natural: f64 = natural_w.iter().sum();
    let gaps_count = (n.saturating_sub(1)) as f64;

    let (scale, gap) = if gap_mode == "fixed" {
        let gap = fixed_gap.min(content_w / 2) as f64;
        let available = content_w as f64 - gap * gaps_count;
        if available < 16.0 {
            return Err("Fixed gap leaves too little room for images".into());
        }
        let scale = if sum_natural > available {
            available / sum_natural
        } else {
            1.0
        };
        (scale, gap)
    } else {
        // Auto gap: prefer full-height images; leftover width is the gap.
        if sum_natural >= content_w as f64 {
            // No room for a gap — shrink uniformly to fit flush.
            (content_w as f64 / sum_natural, 0.0)
        } else {
            let leftover = content_w as f64 - sum_natural;
            let gap = if gaps_count > 0.0 {
                leftover / gaps_count
            } else {
                0.0
            };
            (1.0, gap)
        }
    };

    let mut slots = Vec::with_capacity(images.len());
    let mut x = margin as f64;
    let gap_u = gap.round().max(0.0) as u32;
    for (i, w_nat) in natural_w.iter().enumerate() {
        let w = ((*w_nat * scale).round() as u32).max(2) & !1;
        let h = content_h & !1;
        let y = margin;
        slots.push(PlacedSlot {
            x: x.round() as u32,
            y,
            scale_filter: format!(
                "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgba"
            ),
        });
        x += w as f64;
        if (i as u32) + 1 < n {
            x += gap;
        }
    }
    Ok((slots, gap_u))
}

fn layout_equal_columns(
    n: u32,
    content_w: u32,
    content_h: u32,
    margin: u32,
    gap: u32,
    framing: &str,
) -> Result<(Vec<PlacedSlot>, u32), String> {
    let total_gap = gap.saturating_mul(n.saturating_sub(1));
    if content_w <= total_gap + n * 8 {
        return Err("Plate bake gap is too large for the canvas".into());
    }
    let slot_w = ((content_w - total_gap) / n) & !1;
    let slot_h = content_h & !1;
    if slot_w < 8 || slot_h < 8 {
        return Err("Plate bake slots are too small".into());
    }
    let mut slots = Vec::with_capacity(n as usize);
    for i in 0..n {
        let x = margin + i * (slot_w + gap);
        slots.push(PlacedSlot {
            x,
            y: margin,
            scale_filter: slot_scale_filter(slot_w, slot_h, framing),
        });
    }
    Ok((slots, gap))
}

/// Keep the plate preview cache from growing without bound.
fn prune_old_plate_previews(cache_dir: &Path) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut previews: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("plate-preview-") && n.ends_with(".jpg"))
        })
        .collect();
    if previews.len() <= 8 {
        return;
    }
    previews.sort_by(|a, b| {
        let ma = fs::metadata(a).and_then(|m| m.modified()).ok();
        let mb = fs::metadata(b).and_then(|m| m.modified()).ok();
        ma.cmp(&mb)
    });
    let drop_count = previews.len().saturating_sub(6);
    for path in previews.into_iter().take(drop_count) {
        let _ = fs::remove_file(path);
    }
}

fn bake_plate_still(
    paths: &ParascenePaths,
    input: &PlateBakeInput,
) -> Result<PlateBakeResult, String> {
    let images = resolve_image_paths(paths, &input.image_asset_ids)?;
    let n = images.len() as u32;
    let long_edge = input.resolution.unwrap_or(2048);
    let (out_w, out_h) = output_size(&input.aspect_ratio, long_edge);
    let margin = input.margin_px.unwrap_or(0).min(out_w / 4);
    let placement = match input
        .placement
        .as_deref()
        .unwrap_or("height_fill")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "equal_columns" | "equal" => "equal_columns",
        _ => "height_fill",
    };
    let gap_mode = match input
        .gap_mode
        .as_deref()
        .unwrap_or(if placement == "height_fill" {
            "auto"
        } else {
            "fixed"
        })
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "fixed" => "fixed",
        _ => "auto",
    };
    let fixed_gap = input.gap_px.unwrap_or(0).min(out_w / 2);
    let framing = match input
        .framing
        .as_deref()
        .unwrap_or("fit")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "fill" => "fill",
        "stretch" => "stretch",
        _ => "fit",
    };

    let content_w = out_w.saturating_sub(margin.saturating_mul(2));
    let content_h = out_h.saturating_sub(margin.saturating_mul(2));
    if content_w < 64 || content_h < 64 {
        return Err("Plate bake margins leave too little content area".into());
    }

    let (slots, used_gap) = if placement == "height_fill" {
        layout_height_fill(&images, content_w, content_h, margin, gap_mode, fixed_gap)?
    } else {
        let gap = if gap_mode == "auto" {
            // Equal columns with auto gap: split leftover after fitting? Use 0.
            0
        } else {
            fixed_gap
        };
        layout_equal_columns(n, content_w, content_h, margin, gap, framing)?
    };

    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to bake plates. Install with: brew install ffmpeg".to_string()
    })?;

    let cache_dir = paths.cache.join("plate-stills");
    fs::create_dir_all(&cache_dir).map_err(|e| format!("plate cache dir: {e}"))?;
    let is_preview = input.preview.unwrap_or(false);
    // Unique paths per bake — concurrent preview requests must not share
    // tmp/dest (that left the UI showing a stale / swapped layout).
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = if is_preview {
        prune_old_plate_previews(&cache_dir);
        cache_dir.join(format!("plate-preview-{stamp}-{out_w}x{out_h}.jpg"))
    } else {
        cache_dir.join(format!("plate-{stamp}-{out_w}x{out_h}.jpg"))
    };
    let tmp = cache_dir.join(format!(
        "plate-{}-{stamp}-{out_w}x{out_h}.tmp.jpg",
        if is_preview { "preview" } else { "bake" }
    ));
    let _ = fs::remove_file(&tmp);

    let mut filter_parts: Vec<String> = Vec::new();
    filter_parts.push(format!(
        "color=c=black:s={out_w}x{out_h}:d=1,format=rgba[bg]"
    ));
    for (i, slot) in slots.iter().enumerate() {
        filter_parts.push(format!("[{i}:v]{}[s{i}]", slot.scale_filter));
    }
    let mut prev = "bg".to_string();
    for (i, slot) in slots.iter().enumerate() {
        let next = if i + 1 == slots.len() {
            "out".to_string()
        } else {
            format!("t{i}")
        };
        filter_parts.push(format!(
            "[{prev}][s{i}]overlay=x={}:y={}:format=auto[{next}]",
            slot.x, slot.y
        ));
        prev = next;
    }
    let filter = filter_parts.join(";");

    let mut args: Vec<String> = vec!["-y".into()];
    for path in &images {
        args.push("-i".into());
        args.push(path.to_string_lossy().to_string());
    }
    args.push("-filter_complex".into());
    args.push(filter);
    args.push("-map".into());
    args.push("[out]".into());
    args.push("-frames:v".into());
    args.push("1".into());
    args.push("-q:v".into());
    args.push("2".into());
    args.push("-update".into());
    args.push("1".into());
    args.push(tmp.to_string_lossy().to_string());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_ffmpeg(&ffmpeg, &arg_refs)?;
    if !tmp.is_file() || tmp.metadata().map(|m| m.len() == 0).unwrap_or(true) {
        return Err("Plate bake produced no output file".into());
    }
    let _ = fs::remove_file(&dest);
    fs::rename(&tmp, &dest).map_err(|e| format!("plate bake rename: {e}"))?;
    Ok(PlateBakeResult {
        path: dest.to_string_lossy().to_string(),
        width: out_w,
        height: out_h,
        gap_px: used_gap,
    })
}

#[tauri::command]
pub async fn library_bake_plate_still(input: PlateBakeInput) -> Result<PlateBakeResult, String> {
    let paths = default_paths()?;
    tokio::task::spawn_blocking(move || bake_plate_still(&paths, &input))
        .await
        .map_err(|e| format!("Plate bake task failed: {e}"))?
}

fn safe_cache_part(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let value = value.trim_matches('_');
    if value.is_empty() {
        "composition".into()
    } else {
        value.into()
    }
}

/// Copy a generated still into composition-owned cache without creating a
/// Library row. Library ownership begins only when the user exports the run.
#[tauri::command]
pub fn library_cache_composition_run(
    source_path: String,
    composition_id: String,
) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err("Composition run source file was not found".into());
    }
    let paths = default_paths()?;
    let dir = paths
        .cache
        .join("composition-runs")
        .join(safe_cache_part(&composition_id));
    fs::create_dir_all(&dir).map_err(|e| format!("composition cache dir: {e}"))?;
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("run-{stamp}.{}", safe_cache_part(ext)));
    fs::copy(&source, &dest).map_err(|e| format!("Could not cache composition run: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Delete only a file owned by the composition cache.
#[tauri::command]
pub fn library_delete_composition_run(path: String) -> Result<(), String> {
    let paths = default_paths()?;
    let root = paths.cache.join("composition-runs");
    let file = PathBuf::from(path);
    if !file.starts_with(&root) {
        return Err("Refusing to delete a file outside composition cache".into());
    }
    match fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not delete composition run: {error}")),
    }
}
