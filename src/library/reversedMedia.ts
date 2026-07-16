import { convertFileSrc } from "@tauri-apps/api/core";
import { ensureReversed, type ReversedMedia } from "./catalogClient";

export type ReversedMediaUrls = {
  mediaUrl: string;
  thumbUrl: string | null;
};

const inflight = new Map<string, Promise<ReversedMediaUrls>>();
const resolved = new Map<string, ReversedMediaUrls>();

function toUrls(media: ReversedMedia): ReversedMediaUrls {
  const mediaUrl = convertFileSrc(media.path);
  const thumbUrl = media.thumbPath ? convertFileSrc(media.thumbPath) : null;
  return { mediaUrl, thumbUrl };
}

/** Sync peek at previously resolved reversed media + thumb URLs. */
export function getCachedReversedMedia(
  assetId: string,
): ReversedMediaUrls | null {
  return resolved.get(assetId.trim()) ?? null;
}

/** @deprecated Prefer getCachedReversedMedia — kept for call-site clarity. */
export function getCachedReversedMediaUrl(assetId: string): string | null {
  return getCachedReversedMedia(assetId)?.mediaUrl ?? null;
}

export function getCachedReversedThumbUrl(assetId: string): string | null {
  return getCachedReversedMedia(assetId)?.thumbUrl ?? null;
}

/** Asset-protocol URLs for cached reversed media (+ first-frame thumb). */
export async function ensureReversedMedia(
  assetId: string,
): Promise<ReversedMediaUrls> {
  const id = assetId.trim();
  if (!id) throw new Error("Missing asset id for reverse");

  const cached = resolved.get(id);
  if (cached) return cached;

  let pending = inflight.get(id);
  if (!pending) {
    pending = ensureReversed(id)
      .then((media) => {
        const urls = toUrls(media);
        resolved.set(id, urls);
        inflight.delete(id);
        return urls;
      })
      .catch((err) => {
        inflight.delete(id);
        throw err;
      });
    inflight.set(id, pending);
  }
  return pending;
}

/** Media URL only (same cache as ensureReversedMedia). */
export async function ensureReversedMediaUrl(assetId: string): Promise<string> {
  const urls = await ensureReversedMedia(assetId);
  return urls.mediaUrl;
}
