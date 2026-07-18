import { convertFileSrc } from "@tauri-apps/api/core";
import { ensureClipThumb } from "./catalogClient";

const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function clipThumbnailKey(
  assetId: string,
  reverse: boolean,
  inSec: number,
): string {
  const millis = Math.round(Math.max(0, inSec) * 1000);
  return `${assetId.trim()}:${reverse ? "r" : "f"}:${millis}`;
}

export function getCachedClipThumbnail(
  assetId: string,
  reverse: boolean,
  inSec: number,
): string | null {
  return resolved.get(clipThumbnailKey(assetId, reverse, inSec)) ?? null;
}

export function ensureClipThumbnail(
  assetId: string,
  reverse: boolean,
  inSec: number,
): Promise<string> {
  const id = assetId.trim();
  const timeSec = Math.max(0, inSec);
  const key = clipThumbnailKey(id, reverse, timeSec);
  const cached = resolved.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = ensureClipThumb(id, reverse, timeSec)
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
