import { convertFileSrc } from "@tauri-apps/api/core";
import type { Creation } from "./types";

function fileSrc(path: string): string | null {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

/** True when the backend can fetch cloud bytes for this creation. */
export function canFetchLocal(c: Creation): boolean {
  return Boolean(c.remoteUrl || c.thumbnailUrl);
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

/**
 * Hard unavailable on Parascene (moderated / failed / no assets and not pending).
 * Local download_state `"failed"` is NOT this — that only means retry the save.
 */
export function isParasceneUnavailable(c: Creation): boolean {
  if (c.isModeratedError) return true;
  const s = statusKey(c);
  if (s === "failed" || s === "error" || s === "moderated") return true;
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
    if (src) return src;
  }
  if (c.mediaType === "image" && c.localPath) {
    const src = fileSrc(c.localPath);
    if (src) return src;
  }
  return null;
}

/** Lightbox media — local disk only (never remote). */
export function creationDetailUrl(c: Creation): string | null {
  if (c.localPath) {
    const src = fileSrc(c.localPath);
    if (src) return src;
  }
  return null;
}
