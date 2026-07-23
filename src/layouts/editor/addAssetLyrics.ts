import { isInaudibleLyricLine } from "../../lab/lyricAlign";
import type { AlignedLyricLine, LyricAlignment } from "../../project/types";

/** Use stored alignment whenever present — lyric times are in source-audio seconds. */
export function matchingLyricAlignment(
  alignment: LyricAlignment | null | undefined,
): LyricAlignment | null {
  return alignment ?? null;
}

/** Lyric lines that overlap a half-open `[startSec, endSec)` window. */
export function lyricsInTimeRange(
  lines: readonly AlignedLyricLine[],
  startSec: number,
  endSec: number,
): AlignedLyricLine[] {
  return lines.filter(
    (line) =>
      !isInaudibleLyricLine(line) &&
      line.startSec < endSec &&
      line.endSec > startSec,
  );
}

export function lyricsTextInTimeRange(
  lines: readonly AlignedLyricLine[],
  startSec: number,
  endSec: number,
): string {
  return lyricsInTimeRange(lines, startSec, endSec)
    .map((line) => line.line.trim())
    .filter(Boolean)
    .join("\n");
}

function transcriptTextInTimeRange(
  alignment: LyricAlignment,
  startSec: number,
  endSec: number,
): string {
  const segments = alignment.transcript?.segments ?? [];
  const fromSegments = segments
    .filter(
      (segment) =>
        segment.startSec < endSec &&
        segment.endSec > startSec &&
        segment.text.trim(),
    )
    .map((segment) => segment.text.trim())
    .join("\n");
  if (fromSegments.trim()) return fromSegments;

  const words = alignment.transcript?.words ?? [];
  const inRange = words.filter(
    (word) => word.startSec < endSec && word.endSec > startSec,
  );
  if (inRange.length === 0) return "";
  return inRange.map((word) => word.word.trim()).filter(Boolean).join(" ");
}

/** Aligned lyric lines, then Whisper transcript fallback for the same window. */
export function resolveLyricsForTimeRange(
  alignment: LyricAlignment | null | undefined,
  startSec: number,
  endSec: number,
): string {
  if (!alignment) return "";
  const fromLines = lyricsTextInTimeRange(alignment.lines, startSec, endSec);
  if (fromLines.trim()) return fromLines;
  return transcriptTextInTimeRange(alignment, startSec, endSec);
}
