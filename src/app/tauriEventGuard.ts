/**
 * Tauri's injected event plugin script does
 * `unregisterCallback(listeners[eventId].handlerId)` with no existence check
 * (still true on tauri dev branch as of 2.11). Unlistening an id the window
 * map doesn't hold — e.g. dispose racing the async registration eval, or ids
 * from a previous dev reload — throws a TypeError that surfaces as an
 * unhandled rejection AND aborts the JS api's _unlisten before it reaches the
 * Rust-side removal, leaking the listener there.
 *
 * Wrapping the internal makes a stale-id unregister a no-op so _unlisten can
 * finish its Rust invoke. Call once at startup, before any listen().
 */
export function guardTauriUnregisterListener(
  target: Window & typeof globalThis = window,
): void {
  const internals = (
    target as unknown as Record<string, { unregisterListener?: unknown }>
  ).__TAURI_EVENT_PLUGIN_INTERNALS__;
  const original = internals?.unregisterListener;
  if (typeof original !== "function") return;
  const guarded = (event: string, eventId: number) => {
    try {
      (original as (event: string, eventId: number) => void)(event, eventId);
    } catch {
      // Stale or never-registered id — nothing to unregister.
    }
  };
  try {
    internals.unregisterListener = guarded;
  } catch {
    // Property frozen by a future Tauri version; leave the original in place.
  }
}
