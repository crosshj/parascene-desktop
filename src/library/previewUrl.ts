import { convertFileSrc } from "@tauri-apps/api/core";
import type { Creation } from "./types";

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
  if (c.localPath) {
    const playback = c.mediaType === "video" || c.mediaType === "audio";
    const src = fileSrc(c.localPath, { playback });
    if (src) return withPreviewCacheBust(src, c.updatedAt);
  }
  return null;
}
