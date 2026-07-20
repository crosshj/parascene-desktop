//! Fill local board thumbs from full local media at native aspect.
//!
//! Overwrites `local_thumb_path` with `Library/thumbs/{id}_{token}.fit.jpg`.
//! Frontend may then push the JPEG to Parascene as `?variant=fit`.

use super::catalog::{
    default_paths, get_creation_by_id, ready_connection, set_creation_geometry,
    set_local_thumb_path, Creation,
};
use super::ffmpeg::resolve_ffmpeg;
use super::paths::ParascenePaths;
use image::imageops::FilterType;
use image::DynamicImage;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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

fn content_token(s: &str) -> String {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

fn fit_thumb_stem(creation: &Creation) -> String {
    let token = creation
        .remote_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .or(creation.local_path.as_deref())
        .map(content_token)
        .unwrap_or_else(|| "local".into());
    format!("{}_{}", safe_id(&creation.id), token)
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

/// Pull embedded album art (ID3 APIC / mjpeg cover stream) from an audio file.
fn extract_embedded_cover(ffmpeg: &Path, audio: &Path, dest: &Path) -> Result<(), String> {
    let output = Command::new(ffmpeg)
        .args([
            "-y",
            "-i",
            &audio.display().to_string(),
            "-an",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-q:v",
            "2",
            &dest.display().to_string(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if output.status.success() && dest.is_file() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr);
    if err.contains("Stream map '0:v:0'")
        || err.contains("matches no streams")
        || err.contains("Output file does not contain any stream")
    {
        return Err("No embedded artwork in audio file".into());
    }
    Err(format!(
        "ffmpeg failed extracting embedded cover (exit {})",
        output.status
    ))
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

fn fill_from_audio_file(src: &Path, dest: &Path, temp_cover: &Path) -> Result<(), String> {
    let ffmpeg = resolve_ffmpeg().ok_or_else(|| {
        "FFmpeg is required to fill thumbnails for audio. Install with: brew install ffmpeg"
            .to_string()
    })?;
    extract_embedded_cover(&ffmpeg, src, temp_cover)?;
    let result = fill_from_image_file(temp_cover, dest);
    let _ = std::fs::remove_file(temp_cover);
    result
}

fn is_video_creation(creation: &Creation, local_path: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "video" {
        return true;
    }
    // Catalog type wins — audio often lives in .mp4/.m4a containers.
    if mt == "audio" || mt == "image" {
        return false;
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

fn is_audio_creation(creation: &Creation, local_path: &Path) -> bool {
    let mt = creation.media_type.trim().to_ascii_lowercase();
    if mt == "audio" {
        return true;
    }
    if mt == "video" || mt == "image" {
        return false;
    }
    matches!(
        local_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" | "aiff" | "aif")
    )
}

pub(crate) fn fill_local_thumb(
    paths: &ParascenePaths,
    creation: &Creation,
) -> Result<PathBuf, String> {
    let Some(local) = creation.local_path.as_deref().filter(|p| !p.is_empty()) else {
        return Err("No local media on disk yet — wait for download, then try again.".into());
    };
    let src = path_under_root(&paths.root, local)?;
    let stem = fit_thumb_stem(creation);
    let dest = paths.thumbs.join(format!("{stem}.fit.jpg"));
    if is_video_creation(creation, &src) {
        let temp = paths.cache.join(format!("{stem}.frame.jpg"));
        fill_from_video_file(&src, &dest, &temp)?;
    } else if is_audio_creation(creation, &src) {
        let temp = paths.cache.join(format!("{stem}.cover.jpg"));
        fill_from_audio_file(&src, &dest, &temp)?;
    } else {
        fill_from_image_file(&src, &dest)?;
    }
    Ok(dest)
}

/// Library creative presets — pick the closest ratio to the thumb pixels.
pub(crate) fn nearest_standard_aspect(width: u32, height: u32) -> &'static str {
    if width == 0 || height == 0 {
        return "1:1";
    }
    let r = width as f64 / height as f64;
    const PRESETS: &[(&str, f64)] = &[
        ("1:1", 1.0),
        ("4:5", 4.0 / 5.0),
        ("9:16", 9.0 / 16.0),
        ("16:9", 16.0 / 9.0),
    ];
    PRESETS
        .iter()
        .min_by(|a, b| {
            (r - a.1)
                .abs()
                .partial_cmp(&(r - b.1).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(label, _)| *label)
        .unwrap_or("1:1")
}

/// After writing a board thumb, store width/height and nearest standard aspect.
pub(crate) fn apply_geometry_from_thumb(
    conn: &rusqlite::Connection,
    id: &str,
    thumb: &Path,
) -> Result<(), String> {
    let (w, h) = image::image_dimensions(thumb)
        .map_err(|e| format!("Could not read thumb dimensions: {e}"))?;
    let aspect = nearest_standard_aspect(w, h);
    set_creation_geometry(conn, id, w as i64, h as i64, aspect)
}

/// Fill board thumb, persist path + geometry from the JPEG.
pub(crate) fn fill_and_record_local_thumb(
    paths: &ParascenePaths,
    conn: &rusqlite::Connection,
    creation: &Creation,
) -> Result<PathBuf, String> {
    let dest = fill_local_thumb(paths, creation)?;
    let dest_str = dest.display().to_string();
    set_local_thumb_path(conn, &creation.id, &dest_str)?;
    apply_geometry_from_thumb(conn, &creation.id, &dest)?;
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
    {
        let conn = ready_connection(&paths)?;
        fill_and_record_local_thumb(&paths, &conn, &creation)?;
    }
    emit_creation_updated(&app, &id);
    let conn = ready_connection(&paths)?;
    get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Creation {id} missing after fill"))
}

/// Read the current local board preview as base64 (for pushing fit thumbs to Parascene).
#[tauri::command]
pub fn library_read_local_thumb_base64(id: String) -> Result<String, String> {
    use base64::Engine;
    let paths = default_paths()?;
    let conn = ready_connection(&paths)?;
    let creation =
        get_creation_by_id(&conn, &id)?.ok_or_else(|| format!("Creation {id} not found"))?;
    let Some(stored) = creation
        .local_thumb_path
        .as_deref()
        .filter(|p| !p.is_empty())
    else {
        return Err("No local thumbnail on disk".into());
    };
    let path = path_under_root(&paths.root, stored)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read thumb: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
        let src = PathBuf::from("/Users/anthrowareadmin/Movies/Parascene/Library/media/17995.png");
        if !src.is_file() {
            return;
        }
        let dest =
            std::env::temp_dir().join(format!("parascene-17995-fit-{}.jpg", std::process::id()));
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
        let root = std::env::temp_dir().join(format!("parascene-fill-vid-{}", std::process::id()));
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

    fn dummy_creation(media_type: &str) -> Creation {
        Creation {
            id: "t1".into(),
            title: "t".into(),
            media_type: media_type.into(),
            remote_url: None,
            thumbnail_url: None,
            fit_thumbnail_url: None,
            video_url: None,
            local_path: None,
            local_thumb_path: None,
            published: false,
            published_at: None,
            created_at: String::new(),
            download_state: "local".into(),
            checksum: None,
            prompt: None,
            expires_at: None,
            updated_at: String::new(),
            filename: None,
            description: None,
            color: None,
            status: None,
            width: None,
            height: None,
            aspect_ratio: None,
            nsfw: false,
            is_moderated_error: false,
            remote_json: None,
        }
    }

    #[test]
    fn nearest_standard_aspect_picks_closest_preset() {
        assert_eq!(nearest_standard_aspect(720, 720), "1:1");
        assert_eq!(nearest_standard_aspect(720, 405), "16:9");
        assert_eq!(nearest_standard_aspect(405, 720), "9:16");
        assert_eq!(nearest_standard_aspect(576, 720), "4:5");
        // Slightly off square still maps to 1:1
        assert_eq!(nearest_standard_aspect(700, 720), "1:1");
    }

    #[test]
    fn audio_creation_detected_by_type_and_extension() {
        let by_type = dummy_creation("audio");
        assert!(is_audio_creation(&by_type, Path::new("clip.mp4")));
        assert!(!is_video_creation(&by_type, Path::new("clip.mp4")));

        let unknown = dummy_creation("");
        assert!(is_audio_creation(&unknown, Path::new("song.mp3")));
        assert!(!is_video_creation(&unknown, Path::new("song.mp3")));
    }

    #[test]
    fn audio_without_cover_errors_clearly_when_ffmpeg_present() {
        let Some(ffmpeg) = resolve_ffmpeg() else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "parascene-fill-audio-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // Minimal silent WAV — no video/cover stream.
        let src = root.join("silent.wav");
        let status = Command::new(&ffmpeg)
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=44100:cl=mono",
                "-t",
                "0.1",
                &src.display().to_string(),
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        if !status.map(|s| s.success()).unwrap_or(false) || !src.is_file() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let dest = root.join("out.fit.jpg");
        let temp = root.join("cover.jpg");
        let err = fill_from_audio_file(&src, &dest, &temp).unwrap_err();
        assert!(
            err.contains("No embedded artwork") || err.contains("ffmpeg failed"),
            "unexpected err: {err}"
        );
        assert!(!dest.is_file());
        let _ = fs::remove_dir_all(&root);
    }
}
