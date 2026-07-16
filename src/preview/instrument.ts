import type { PreviewInstrumentEvent } from "./types";

type Listener = (event: PreviewInstrumentEvent) => void;

const listeners = new Set<Listener>();

export function subscribePreviewInstrument(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPreviewInstrument(event: PreviewInstrumentEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Instrumentation must never break preview.
    }
  }
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug("[preview]", event);
  }
}
