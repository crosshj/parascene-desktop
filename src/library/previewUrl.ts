import { convertFileSrc } from "@tauri-apps/api/core";
import type { Creation } from "./types";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "avif",
]);
const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "aiff",
  "aif",
]);
const VIDEO_EXTS = new Set([
  "mp4",
  "mov",
  "webm",
  "m4v",
  "mkv",
  "avi",
]);

function pathExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** True when a URL/path is cover/poster art rather than playable A/V. */
export function urlLooksLikeImage(url: string | null | undefined): boolean {
  const trimmed = url?.trim();
  if (!trimmed) return false;
  const path = trimmed.split(/[?#]/)[0] ?? "";
  return IMAGE_EXTS.has(pathExtension(path));
}

/**
 * True when `localPath` looks like real playable media for this creation kind.
 * Cloud audio imports often store the cover PNG as `local_path` and mark
 * download_state=local — feeding that into `<audio>` spins forever.
 */
export function isPlayableLocalPath(
  path: string | null | undefined,
  mediaType: string | null | undefined,
): boolean {
  const trimmed = path?.trim();
  if (!trimmed) return false;
  const ext = pathExtension(trimmed);
  if (!ext) return true;
  const kind = String(mediaType ?? "")
    .trim()
    .toLowerCase();
  if (kind === "audio") return AUDIO_EXTS.has(ext);
  if (kind === "video") return VIDEO_EXTS.has(ext);
  if (kind === "image") return IMAGE_EXTS.has(ext) || !AUDIO_EXTS.has(ext);
  return true;
}

/**
 * Local file URL for WebView.
 * Video/audio must use the custom `media` scheme (HTTP Range) — WebKit on
 * macOS often fails mid-stream on Tauri's built-in `asset://` for large A/V,
 * which surfaces as a stuck poster/thumb with no sound while the playhead
 * still advances.
 */
function fileSrc(
  path: string,
  opts?: { playback?: boolean },
): string | null {
  try {
    if (opts?.playback) {
      return convertFileSrc(path, "media");
    }
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/**
 * Bust WebView / in-process image caches when the same disk path is rewritten
 * (e.g. group cover re-download after filing a new member).
 */
export function withPreviewCacheBust(
  src: string,
  version: string | null | undefined,
): string {
  const v = version?.trim();
  if (!v) return src;
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}v=${encodeURIComponent(v)}`;
}

/** True when the backend can fetch cloud bytes for this creation. */
export function canFetchLocal(c: Creation): boolean {
  return Boolean(c.remoteUrl || c.fitThumbnailUrl || c.thumbnailUrl);
}

/**
 * True when Parascene has a remote that could become playable audio/video.
 * Cover-only Suno/YouTube rows point `remote_url` at a PNG — caching that
 * never yields a track or movie, so the UI must not wait on "Saving locally…".
 */
export function canFetchPlayableMedia(c: Creation): boolean {
  const kind = String(c.mediaType ?? "")
    .trim()
    .toLowerCase();
  if (kind === "audio" || kind === "video") {
    if (kind === "video" && c.videoUrl?.trim() && !urlLooksLikeImage(c.videoUrl)) {
      return true;
    }
    return Boolean(c.remoteUrl?.trim()) && !urlLooksLikeImage(c.remoteUrl);
  }
  return canFetchLocal(c);
}

/** Audio/video with no playable local file and no playable remote to cache. */
export function isCoverOnlyCloudAv(c: Creation): boolean {
  const kind = String(c.mediaType ?? "")
    .trim()
    .toLowerCase();
  if (kind !== "audio" && kind !== "video") return false;
  if (isPlayableLocalPath(c.localPath, c.mediaType)) return false;
  return !canFetchPlayableMedia(c);
}

function statusKey(c: Creation): string {
  return (c.status || "").trim().toLowerCase();
}

/** Still waiting on Parascene to produce assets (not a hard failure). */
export function isParascenePending(c: Creation): boolean {
  const s = statusKey(c);
  return (
    s === "pending" ||
    s === "processing" ||
    s === "creating" ||
    s === "queued" ||
    s === "running" ||
    s.startsWith("creating")
  );
}

/** True when full media or a board thumb is already on disk. */
export function hasLocalMedia(c: Creation): boolean {
  return Boolean(c.localPath?.trim() || c.localThumbPath?.trim());
}

/**
 * Hard unavailable on Parascene (moderated / failed / no assets and not pending).
 * Local download_state `"failed"` is NOT this — that only means retry the save.
 * Disk-only imports (no remote URLs) with local files are available.
 */
export function isParasceneUnavailable(c: Creation): boolean {
  if (c.isModeratedError) return true;
  const s = statusKey(c);
  if (s === "failed" || s === "error" || s === "moderated") return true;
  if (hasLocalMedia(c)) return false;
  if (canFetchLocal(c) || isParascenePending(c)) return false;
  return true;
}

/**
 * Board preview — local thumb (or local image file). Never remote URLs.
 * Videos use their thumbnail on the board; full video is lightbox-only.
 */
export function creationPreviewUrl(c: Creation): string | null {
  if (c.localThumbPath) {
    const src = fileSrc(c.localThumbPath);
    if (src) return withPreviewCacheBust(src, c.updatedAt);
  }
  if (c.mediaType === "image" && c.localPath) {
    const src = fileSrc(c.localPath);
    if (src) return withPreviewCacheBust(src, c.updatedAt);
  }
  return null;
}

/** Lightbox / Editor / timeline media — local disk only (never remote). */
export function creationDetailUrl(c: Creation): string | null {
  if (c.localPath && isPlayableLocalPath(c.localPath, c.mediaType)) {
    const kind = String(c.mediaType ?? "")
      .trim()
      .toLowerCase();
    const playback = kind === "video" || kind === "audio";
    const src = fileSrc(c.localPath, { playback });
    if (src) return withPreviewCacheBust(src, c.updatedAt);
  }
  return null;
}
