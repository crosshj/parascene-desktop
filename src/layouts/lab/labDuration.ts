/** Format Lab run / prediction durations for display. */

export function formatLabDuration(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}
