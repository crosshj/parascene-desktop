import { creationPreviewUrl } from "./previewUrl";
import type { Creation } from "./types";

const warmed = new Set<string>();
const decoded = new Set<string>();
const waiters = new Map<string, Array<() => void>>();

function warmKey(creation: Creation): string {
  return `${creation.id}:${creation.localThumbPath ?? ""}:${creation.localPath ?? ""}`;
}

function notifyReady(src: string): void {
  decoded.add(src);
  const list = waiters.get(src);
  if (!list) return;
  waiters.delete(src);
  for (const resolve of list) resolve();
}

/** True once this asset:// / file src has finished decoding in-process. */
export function isPreviewDecoded(src: string): boolean {
  return decoded.has(src);
}

/**
 * Resolves when `src` is decoded (or already was). Used so board cards don't
 * paint a grey slot while the browser is still decoding after virtual remount.
 */
export function whenPreviewReady(src: string): Promise<void> {
  if (decoded.has(src)) return Promise.resolve();
  return new Promise((resolve) => {
    const list = waiters.get(src) ?? [];
    list.push(resolve);
    waiters.set(src, list);
    startDecode(src);
  });
}

function startDecode(src: string): void {
  if (decoded.has(src)) {
    notifyReady(src);
    return;
  }
  const img = new Image();
  const finish = () => notifyReady(src);
  const fail = () => {
    // Still release waiters so cards can fall through to broken/pending UI.
    notifyReady(src);
  };
  img.onload = () => {
    if (typeof img.decode === "function") {
      void img.decode().then(finish).catch(finish);
    } else {
      finish();
    }
  };
  img.onerror = fail;
  img.src = src;
  if (img.complete && img.naturalWidth > 0) {
    img.onload = null;
    if (typeof img.decode === "function") {
      void img.decode().then(finish).catch(finish);
    } else {
      finish();
    }
  }
}

/** Decode local thumbs into memory before cards remount on scroll. */
export function warmLocalPreviews(creations: Creation[]): void {
  for (const creation of creations) {
    const key = warmKey(creation);
    if (warmed.has(key)) continue;
    const src = creationPreviewUrl(creation);
    if (!src) continue;
    warmed.add(key);
    startDecode(src);
  }
}
