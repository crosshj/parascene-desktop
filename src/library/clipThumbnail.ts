import { convertFileSrc } from "@tauri-apps/api/core";
import { ensureClipThumb } from "./catalogClient";

const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export type ClipThumbnailComposition = {
  framing: "fit" | "fill" | "stretch";
  aspectRatio: string;
  zoom: number;
  centerX: number;
  centerY: number;
};

/** Same composition the timeline / program monitor uses for a clip instance. */
export function clipTimelineComposition(
  clip: {
    framing?: string | null;
    zoom?: number | null;
    centerX?: number | null;
    centerY?: number | null;
  },
  aspectRatio: string,
): ClipThumbnailComposition {
  const framing =
    clip.framing === "fill" || clip.framing === "stretch" ? clip.framing : "fit";
  return {
    framing,
    aspectRatio,
    zoom: Math.min(4, Math.max(1, Number(clip.zoom) || 1)),
    centerX: Math.min(50, Math.max(-50, Number(clip.centerX) || 0)),
    centerY: Math.min(50, Math.max(-50, Number(clip.centerY) || 0)),
  };
}

export function clipThumbnailKey(
  assetId: string,
  reverse: boolean,
  inSec: number,
  composition?: ClipThumbnailComposition,
): string {
  const millis = Math.round(Math.max(0, inSec) * 1000);
  if (!composition) return `${assetId.trim()}:${reverse ? "r" : "f"}:${millis}`;
  return [
    assetId.trim(),
    reverse ? "r" : "f",
    millis,
    composition.aspectRatio,
    composition.framing,
    Math.round(composition.zoom * 1000),
    Math.round(composition.centerX * 100),
    Math.round(composition.centerY * 100),
  ].join(":");
}

export function getCachedClipThumbnail(
  assetId: string,
  reverse: boolean,
  inSec: number,
  composition?: ClipThumbnailComposition,
): string | null {
  return resolved.get(clipThumbnailKey(assetId, reverse, inSec, composition)) ?? null;
}

export function ensureClipThumbnail(
  assetId: string,
  reverse: boolean,
  inSec: number,
  composition?: ClipThumbnailComposition,
): Promise<string> {
  const id = assetId.trim();
  const timeSec = Math.max(0, inSec);
  const key = clipThumbnailKey(id, reverse, timeSec, composition);
  const cached = resolved.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = ensureClipThumb(id, reverse, timeSec, composition)
    .then((path) => {
      const url = convertFileSrc(path);
      resolved.set(key, url);
      inflight.delete(key);
      return url;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, request);
  return request;
}

export function invalidateClipThumbnails(assetIds?: readonly string[]): void {
  if (!assetIds) {
    resolved.clear();
    inflight.clear();
    return;
  }
  const ids = new Set(assetIds.map((id) => id.trim()));
  for (const key of [...resolved.keys()]) {
    if (ids.has(key.slice(0, key.indexOf(":")))) resolved.delete(key);
  }
  for (const key of [...inflight.keys()]) {
    if (ids.has(key.slice(0, key.indexOf(":")))) inflight.delete(key);
  }
}
