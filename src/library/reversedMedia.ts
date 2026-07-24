import { convertFileSrc } from "@tauri-apps/api/core";
import { ensureReversed, type ReversedMedia } from "./catalogClient";

export type ReversedMediaUrls = {
  mediaUrl: string;
  thumbUrl: string | null;
};

const inflight = new Map<string, Promise<ReversedMediaUrls>>();
const resolved = new Map<string, ReversedMediaUrls>();

type ReversedMediaListener = (assetId: string) => void;
const listeners = new Set<ReversedMediaListener>();

function notifyReversedMedia(assetId: string): void {
  for (const listener of listeners) listener(assetId);
}

/** Notify when the in-memory reverse cache gains or loses an entry. */
export function subscribeReversedMediaCache(
  listener: ReversedMediaListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function toUrls(media: ReversedMedia): ReversedMediaUrls {
  // Playback needs Range (`media`); thumbs stay on `asset`.
  const mediaUrl = convertFileSrc(media.path, "media");
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
        notifyReversedMedia(id);
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

/**
 * Drop memoized reversed URLs so the next ensure re-fetches from disk. Pass
 * specific ids after a rebuild, or omit to clear everything.
 */
export function invalidateReversedMedia(assetIds?: readonly string[]): void {
  if (!assetIds) {
    const ids = [...resolved.keys()];
    resolved.clear();
    inflight.clear();
    for (const id of ids) notifyReversedMedia(id);
    return;
  }
  for (const raw of assetIds) {
    const id = raw.trim();
    resolved.delete(id);
    inflight.delete(id);
    notifyReversedMedia(id);
  }
}
