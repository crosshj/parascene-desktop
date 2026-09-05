import { useSyncExternalStore } from "react";

const STORAGE_KEY = "parascene.labsEnabled";
const CHANGED_EVENT = "parascene:labs-enabled-changed";

export function loadLabsEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveLabsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    /* private mode etc. — setting just won't persist */
  }
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/** Live Labs visibility; re-renders when Settings changes it. */
export function useLabsEnabled(): boolean {
  return useSyncExternalStore(subscribe, loadLabsEnabled, () => false);
}
