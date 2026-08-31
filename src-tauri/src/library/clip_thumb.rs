//! Cached first-frame thumbnails for trimmed timeline clips.

use super::catalog::{default_paths, get_creation_by_id, ready_connection, Creation};
use super::ffmpeg::{self, resolve_ffmpeg};
use super::paths::ParascenePaths;
use super::reverse::existing_reversed_media;
use std::fs;
use std::path::{Path, PathBuf};

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
    if !file_canon.starts_with(&root_canon) || !file_canon.is_file() {
        return Err("Local media path is outside the Parascene library".into());
    }
    Ok(file_canon)
}

fn cache_dir(paths: &ParascenePaths) -> PathBuf {
    paths.cache.join("clip-thumbs").join("v3")
}

#[derive(Clone)]
struct Composition {
    framing: String,
    width: u32,
    height: u32,
    zoom: f64,
    center_x: f64,
    center_y: f64,
}

fn output_size(aspect_ratio: Option<&str>) -> (u32, u32) {
    let ratio = aspect_ratio
        .and_then(|value| value.split_once(':'))
        .and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?)))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
        .map(|(w, h)| w / h)
        .unwrap_or(16.0 / 9.0);
    let even = |value: f64| ((value.round() as u32).max(2) / 2) * 2;
    if ratio >= 1.0 {
        (720, even(720.0 / ratio))
    } else {
        (even(720.0 * ratio), 720)
    }
}

fn cache_path(
    paths: &ParascenePaths,
    id: &str,
    reverse: bool,
    time_sec: f64,
    composition: Option<&Composition>,
) -> PathBuf {
    let millis = (time_sec.max(0.0) * 1000.0).round() as u64;
    match composition {
        Some(composition) => {
            let zoom = (composition.zoom * 1000.0).round() as i64;
            let center_x = (composition.center_x * 100.0).round() as i64;
            let center_y = (composition.center_y * 100.0).round() as i64;
            cache_dir(paths).join(format!(
                "{}-{}-{millis}-{}-{}x{}-z{zoom}-x{center_x}-y{center_y}.jpg",
                safe_id(id),
                if reverse { "r" } else { "f" },
                safe_id(&composition.framing),
                composition.width,
                composition.height,
            ))
        }
        None => cache_dir(paths).join(format!(
            "{}-{}-{millis}-raw.jpg",
            safe_id(id),
            if reverse { "r" } else { "f" },
        )),
    }
}

fn source_path(
    paths: &ParascenePaths,
    creation: &Creation,
    reverse: bool,
) -> Result<PathBuf, String> {
    if reverse {
        // Never bake reverse from a thumbnail request — wait for the Bake button.
        let reversed = existing_reversed_media(paths, creation)
            .ok_or_else(|| "Reversed media is not baked yet — hit Bake, then retry".to_string())?;
        return Ok(PathBuf::from(reversed.path));
    }
    let local = creation
        .local_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| "No local media on disk yet".to_string())?;
    path_under_root(&paths.root, local)
}

fn composition_filter(composition: &Composition) -> String {
    let w = composition.width;
    let h = composition.height;
    let zoom = composition.zoom.clamp(1.0, 4.0);
    if composition.framing == "fit" {
        // Match editor preview Fit exactly: the image is contained and
        // transformed in a 16:9 stage; the project-aspect matte is then cut
        // from the center of that transformed stage.
        let project_ratio = w as f64 / h as f64;
        let (stage_w, stage_h) = if project_ratio <= 16.0 / 9.0 {
            ((((h as f64 * 16.0 / 9.0).round() as u32).max(2) / 2) * 2, h)
        } else {
            (w, (((w as f64 * 9.0 / 16.0).round() as u32).max(2) / 2) * 2)
        };
        let dx = composition.center_x.clamp(-50.0, 50.0) / 100.0 * stage_w as f64;
        let dy = composition.center_y.clamp(-50.0, 50.0) / 100.0 * stage_h as f64;
        return format!(
                    "scale={stage_w}:{stage_h}:force_original_aspect_ratio=decrease,pad={stage_w}:{stage_h}:(ow-iw)/2:(oh-ih)/2:black,scale=iw*{zoom:.6}:ih*{zoom:.6},pad=iw+{stage_w}:ih+{stage_h}:{stage_w}/2:{stage_h}/2:black,crop={stage_w}:{stage_h}:(iw-{stage_w})/2-{dx:.3}:(ih-{stage_h})/2-{dy:.3},crop={w}:{h}:(iw-{w})/2:(ih-{h})/2,format=yuv420p"
        );
    }
    let base = match composition.framing.as_str() {
        "stretch" => format!("scale={w}:{h}"),
        _ => format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"),
    };
    let dx = composition.center_x.clamp(-50.0, 50.0) / 100.0 * w as f64;
    let dy = composition.center_y.clamp(-50.0, 50.0) / 100.0 * h as f64;
    format!(
        "{base},scale=iw*{zoom:.6}:ih*{zoom:.6},pad=iw+{w}:ih+{h}:{w}/2:{h}/2:black,crop={w}:{h}:(iw-{w})/2-{dx:.3}:(ih-{h})/2-{dy:.3},format=yuv420p"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn composition_filter_contains_frame_and_instance_transform() {
        let filter = composition_filter(&Composition {
            framing: "fill".into(),
            width: 720,
            height: 404,
            zoom: 1.75,
            center_x: 12.0,
            center_y: -8.0,
        });
        assert!(filter.contains("force_original_aspect_ratio=increase,crop=720:404"));
        assert!(filter.contains("scale=iw*1.750000:ih*1.750000"));
        assert!(filter.contains("-86.400"));
        assert!(filter.contains("--32.320"));
    }

    #[test]
    fn output_size_preserves_project_aspect_with_even_dimensions() {
        assert_eq!(output_size(Some("16:9")), (720, 404));
        assert_eq!(output_size(Some("9:16")), (404, 720));
        assert_eq!(output_size(Some("1:1")), (720, 720));
    }

    #[test]
    fn fit_uses_frontend_sixteen_by_nine_stage_before_project_crop() {
        let filter = composition_filter(&Composition {
            framing: "fit".into(),
            width: 404,
            height: 720,
            zoom: 1.5,
            center_x: 10.0,
            center_y: -5.0,
        });
        assert!(
            filter.starts_with("scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720")
        );
        assert!(filter.contains("crop=1280:720"));
        assert!(filter.contains("crop=404:720:(iw-404)/2:(ih-720)/2"));
        assert!(filter.contains("-128.000"));
        assert!(filter.contains("--36.000"));
    }

    #[test]
    fn ffmpeg_composition_honors_zoom_and_frontend_center_direction() {
        if resolve_ffmpeg().is_none() {
            return;
        }
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("parascene-clip-thumb-{nonce}"));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.png");
        let output = dir.join("output.jpg");
        let mut input = RgbImage::new(100, 100);
        for (x, _, pixel) in input.enumerate_pixels_mut() {
            *pixel = if x < 50 {
                Rgb([240, 10, 10])
            } else {
                Rgb([10, 10, 240])
            };
        }
        input.save(&source).unwrap();
        extract_frame(
            &source,
            0.0,
            &output,
            Some(&Composition {
                framing: "fit".into(),
                width: 100,
                height: 100,
                zoom: 2.0,
                center_x: 25.0,
                center_y: 0.0,
            }),
        )
        .unwrap();
        let rendered = image::open(&output).unwrap().to_rgb8();
        let (red, blue) = rendered.pixels().fold((0_u64, 0_u64), |(r, b), p| {
            (r + p[0] as u64, b + p[2] as u64)
        });
        // Frontend translate(+X) moves the image right, exposing more of its
        // left (red) side inside the stationary frame.
        assert!(red > blue * 2, "expected +Center X to move image right");
        let _ = fs::remove_dir_all(dir);
    }
}

fn probe_duration_sec(ffmpeg: &std::path::Path, source: &Path) -> Option<f64> {
    let output = ffmpeg::command(ffmpeg)
        .args(["-hide_banner", "-i", source.to_str()?])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .ok()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
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

fn extract_frame(
    source: &Path,
    time_sec: f64,
    dest: &Path,
    composition: Option<&Composition>,
) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to create clip thumbnails. Install with: brew install ffmpeg"
            .to_string()
    })?;
    let duration = probe_duration_sec(&ffmpeg, source).unwrap_or(0.0);
    let vf = composition.map(composition_filter).unwrap_or_else(|| {
        "scale=720:720:force_original_aspect_ratio=decrease,format=yuv420p".into()
    });
    ffmpeg::extract_video_jpeg(&ffmpeg, source, dest, time_sec, duration, &vf).map_err(|e| {
        format!("FFmpeg failed extracting clip frame: {e}")
    })
}

fn ensure_clip_thumb(
    paths: &ParascenePaths,
    creation: &Creation,
    reverse: bool,
    time_sec: f64,
    composition: Option<&Composition>,
) -> Result<PathBuf, String> {
    let dest = cache_path(paths, &creation.id, reverse, time_sec, composition);
    if dest.is_file() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(dest);
    }
    fs::create_dir_all(cache_dir(paths))
        .map_err(|e| format!("Could not create clip thumbnail cache: {e}"))?;
    let source = source_path(paths, creation, reverse)?;
    extract_frame(&source, time_sec, &dest, composition)?;
    Ok(dest)
}

/// Shared by Tauri command and `local.extract_frame` service Result mode.
pub(crate) async fn ensure_clip_thumb_path(
    id: String,
    reverse: bool,
    time_sec: f64,
    framing: Option<String>,
    aspect_ratio: Option<String>,
    zoom: Option<f64>,
    center_x: Option<f64>,
    center_y: Option<f64>,
) -> Result<String, String> {
    let paths = default_paths()?;
    let (width, height) = output_size(aspect_ratio.as_deref());
    let composition = aspect_ratio.as_ref().map(|_| Composition {
        framing: match framing.as_deref() {
            Some("fill") => "fill".into(),
            Some("stretch") => "stretch".into(),
            _ => "fit".into(),
        },
        width,
        height,
        zoom: zoom.unwrap_or(1.0).clamp(1.0, 4.0),
        center_x: center_x.unwrap_or(0.0).clamp(-50.0, 50.0),
        center_y: center_y.unwrap_or(0.0).clamp(-50.0, 50.0),
    });
    tauri::async_runtime::spawn_blocking(move || {
        let conn = ready_connection(&paths)?;
        let creation = get_creation_by_id(&conn, id.trim())?
            .ok_or_else(|| format!("Creation not found: {}", id.trim()))?;
        ensure_clip_thumb(&paths, &creation, reverse, time_sec, composition.as_ref())
            .map(|path| path.display().to_string())
    })
    .await
    .map_err(|e| format!("Clip thumbnail task failed: {e}"))?
}

pub(crate) fn delete_clip_thumbs_for_asset(
    paths: &ParascenePaths,
    asset_id: &str,
) -> Result<(), String> {
    let dir = cache_dir(paths);
    if !dir.is_dir() {
        return Ok(());
    }
    let prefix = format!("{}-", safe_id(asset_id));
    for entry in
        fs::read_dir(&dir).map_err(|e| format!("Could not read clip thumbnail cache: {e}"))?
    {
        let entry = entry.map_err(|e| format!("Could not read clip thumbnail entry: {e}"))?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn library_ensure_clip_thumb(
    id: String,
    reverse: bool,
    time_sec: f64,
    framing: Option<String>,
    aspect_ratio: Option<String>,
    zoom: Option<f64>,
    center_x: Option<f64>,
    center_y: Option<f64>,
) -> Result<String, String> {
    ensure_clip_thumb_path(
        id,
        reverse,
        time_sec,
        framing,
        aspect_ratio,
        zoom,
        center_x,
        center_y,
    )
    .await
}
