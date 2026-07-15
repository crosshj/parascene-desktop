import { creationPreviewUrl } from "./previewUrl";
import type { Creation } from "./types";

const warmed = new Set<string>();

/** Decode local thumbs into the browser cache before cards remount on scroll. */
export function warmLocalPreviews(creations: Creation[]): void {
  for (const creation of creations) {
    if (warmed.has(creation.id)) continue;
    const src = creationPreviewUrl(creation);
    if (!src) continue;
    warmed.add(creation.id);
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  }
}
