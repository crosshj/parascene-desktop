//! Fill local board thumbs from full local media at native aspect.
//!
//! Overwrites `local_thumb_path` with `Library/thumbs/{id}.fit.jpg`.
//! Does not touch Parascene cloud assets.

use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, set_local_thumb_path, Creation,
};
use super::paths::ParascenePaths;
use image::imageops::FilterType;
use image::DynamicImage;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

const LONG_EDGE: u32 = 720;

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
    if !file_canon.starts_with(&root_canon) {
        return Err("Local media path is outside the Parascene library".into());
    }
    if !file_canon.is_file() {
        return Err("Local media file not found".into());
    }
    Ok(file_canon)
}

fn resolve_ffmpeg() -> Option<PathBuf> {
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

fn extract_video_frame(ffmpeg: &Path, video: &Path, dest: &Path) -> Result<(), String> {
    // Decode from the start (no -ss) so we get the exact first video frame.
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            &video.display().to_string(),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            &dest.display().to_string(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if status.success() && dest.is_file() {
        Ok(())
    } else {
        Err(format!("ffmpeg failed extracting frame (exit {status})"))
    }
}

fn resize_to_long_edge(img: DynamicImage, long_edge: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return img;
    }
    let max = w.max(h);
    if max <= long_edge {
        return img;
    }
    let scale = long_edge as f32 / max as f32;
    let nw = ((w as f32) * scale).round().max(1.0) as u32;
    let nh = ((h as f32) * scale).round().max(1.0) as u32;
    img.resize(nw, nh, FilterType::Lanczos3)
}

fn write_fit_jpeg(img: DynamicImage, dest: &Path) -> Result<(), String> {
    let rgb = img.into_rgb8();
    let mut out = std::fs::File::create(dest)
        .map_err(|e| format!("Could not write thumb {}: {e}", dest.display()))?;
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    encoder
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEG encode failed: {e}"))?;
    Ok(())
}

fn fill_from_image_file(src: &Path, dest: &Path) -> Result<(), String> {
    let img = image::open(src).map_err(|e| format!("Could not open image: {e}"))?;
    let resized = resize_to_long_edge(img, LONG_EDGE);
    write_fit_jpeg(resized, dest)
}

fn fill_from_video_file(src: &Path, dest: &Path, temp_frame: &Path) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to fill thumbnails for videos. Install with: brew install ffmpeg"
            .to_string()
    })?;
    extract_video_frame(&ffmpeg, src, temp_frame)?;
    let result = fill_from_image_file(temp_frame, dest);
    let _ = std::fs::remove_file(temp_frame);
    result
}

fn is_video_creation(creation: &Creation, local_path: &Path) -> bool {
    if creation.media_type.eq_ignore_ascii_case("video") {
        return true;
    }
    matches!(
        local_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mov" | "webm" | "mkv" | "m4v")
    )
}

pub(crate) fn fill_local_thumb(
    paths: &ParascenePaths,
    creation: &Creation,
) -> Result<PathBuf, String> {
    let Some(local) = creation
        .local_path
        .as_deref()
        .filter(|p| !p.is_empty())
    else {
        return Err("No local media on disk yet — wait for download, then try again.".into());
    };
    let src = path_under_root(&paths.root, local)?;
    let stem = safe_id(&creation.id);
    let dest = paths.thumbs.join(format!("{stem}.fit.jpg"));
    if is_video_creation(creation, &src) {
        let temp = paths.cache.join(format!("{stem}.frame.jpg"));
        fill_from_video_file(&src, &dest, &temp)?;
    } else {
        fill_from_image_file(&src, &dest)?;
    }
    Ok(dest)
}

fn emit_creation_updated(app: &AppHandle, id: &str) {
    let Ok(paths) = default_paths() else {
        return;
    };
    let Ok(conn) = ready_connection(&paths) else {
        return;
    };
    if let Ok(Some(creation)) = get_creation_by_id(&conn, id) {
        let _ = app.emit("library-creation-updated", creation);
    }
}

/// Regenerate the local board preview from full local media (native aspect).
#[tauri::command]
pub fn library_fill_thumb(app: AppHandle, id: String) -> Result<Creation, String> {
    let paths = default_paths()?;
    let creation = {
        let conn = ready_connection(&paths)?;
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Creation {id} not found"))?
    };
    let dest = fill_local_thumb(&paths, &creation)?;
    let dest_str = dest.display().to_string();
    {
        let conn = ready_connection(&paths)?;
        set_local_thumb_path(&conn, &id, &dest_str)?;
    }
    emit_creation_updated(&app, &id);
    let conn = ready_connection(&paths)?;
    get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Creation {id} missing after fill"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::fs;

    #[test]
    fn resize_keeps_aspect_for_widescreen() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(1920, 1080, Rgb([10, 20, 30])));
        let out = resize_to_long_edge(img, 720);
        assert_eq!(out.width(), 720);
        assert_eq!(out.height(), 405);
    }

    #[test]
    fn fill_from_png_writes_fit_jpeg() {
        let root = std::env::temp_dir().join(format!(
            "parascene-fill-thumb-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        let thumbs = root.join("thumbs");
        fs::create_dir_all(&thumbs).unwrap();
        let src = root.join("src.png");
        RgbImage::from_pixel(800, 400, Rgb([1, 2, 3]))
            .save_with_format(&src, ImageFormat::Png)
            .unwrap();
        let dest = thumbs.join("x.fit.jpg");
        fill_from_image_file(&src, &dest).expect("fill");
        assert!(dest.is_file());
        let loaded = image::open(&dest).expect("open fit");
        assert_eq!(loaded.width(), 720);
        assert_eq!(loaded.height(), 360);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fill_real_library_portrait_when_present() {
        let src = PathBuf::from(
            "/Users/anthrowareadmin/Movies/Parascene/Library/media/17995.png",
        );
        if !src.is_file() {
            return;
        }
        let dest = std::env::temp_dir().join(format!(
            "parascene-17995-fit-{}.jpg",
            std::process::id()
        ));
        let _ = fs::remove_file(&dest);
        fill_from_image_file(&src, &dest).expect("fill real");
        let loaded = image::open(&dest).expect("open");
        // 912x1136 → long edge 720 → 578x720
        assert_eq!(loaded.width(), 578);
        assert_eq!(loaded.height(), 720);
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn video_without_ffmpeg_errors_clearly() {
        if resolve_ffmpeg().is_some() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "parascene-fill-vid-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&root);
        let fake = root.join("clip.mp4");
        fs::write(&fake, b"not-a-real-video").unwrap();
        let dest = root.join("out.fit.jpg");
        let temp = root.join("frame.jpg");
        let err = fill_from_video_file(&fake, &dest, &temp).unwrap_err();
        assert!(
            err.contains("FFmpeg") && err.contains("brew install ffmpeg"),
            "unexpected err: {err}"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
