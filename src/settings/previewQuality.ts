import { useSyncExternalStore } from "react";

/**
 * Timeline preview encode quality: resolution, bitrate, and frame rate
 * (low 10fps / medium 15fps / high 30fps). The cut grid and export are
 * unaffected. The value participates in fragment fingerprints, so changing
 * it dirties the whole preview cache and fragments re-bake at the new quality.
 */
export type PreviewQuality = "low" | "medium" | "high";

/** Used when nothing is stored yet or a stored value is unrecognized. */
export const DEFAULT_PREVIEW_QUALITY: PreviewQuality = "low";

export const PREVIEW_QUALITY_ORDER: readonly PreviewQuality[] = [
  "low",
  "medium",
  "high",
];

export const PREVIEW_QUALITY_LABELS: Record<PreviewQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const STORAGE_KEY = "parascene.previewQuality";
const CHANGED_EVENT = "parascene:preview-quality-changed";

export function normalizePreviewQuality(value: unknown): PreviewQuality {
  return value === "medium" || value === "high"
    ? value
    : DEFAULT_PREVIEW_QUALITY;
}

export function loadPreviewQuality(): PreviewQuality {
  try {
    return normalizePreviewQuality(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PREVIEW_QUALITY;
  }
}

export function savePreviewQuality(quality: PreviewQuality): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    /* private mode etc. — setting just won't persist */
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/** Live preview-quality setting; re-renders when Settings changes it. */
export function usePreviewQuality(): PreviewQuality {
  return useSyncExternalStore(subscribe, loadPreviewQuality);
}
