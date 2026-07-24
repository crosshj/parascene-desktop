export type TimelineClipLayoutTier = "wide" | "compact" | "sliver";

export function timelineClipLayoutTier(widthPx: number): TimelineClipLayoutTier {
  if (widthPx >= 56) return "wide";
  if (widthPx >= 20) return "compact";
  return "sliver";
}

/** Duration label that stays readable on narrow timeline clips. */
export function formatClipDurationCompact(
  sec: number,
  widthPx: number,
): string | null {
  if (!Number.isFinite(sec) || sec < 0) return widthPx >= 12 ? "0" : null;
  if (widthPx >= 28) return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
  if (widthPx >= 12) return `${Math.max(1, Math.round(sec))}`;
  return null;
}

/** Lyric lane text that avoids useless lone ellipses on narrow blocks. */
export function lyricBlockLabel(line: string, widthPx: number): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (widthPx >= 40) return trimmed;
  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  if (widthPx >= 20) {
    if (firstWord.length <= 6) return firstWord;
    return `${firstWord.slice(0, 5)}…`;
  }
  if (widthPx >= 10) return firstWord.slice(0, 1).toUpperCase();
  return "·";
}
