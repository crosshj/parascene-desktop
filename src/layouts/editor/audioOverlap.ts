import type { TimelineClip } from "../../project/types";

export type Interval = { startSec: number; endSec: number };

/** Half-open interval intersection length; 0 when no overlap. */
export function overlapDurationSec(a: Interval, b: Interval): number {
  const start = Math.max(a.startSec, b.startSec);
  const end = Math.min(a.endSec, b.endSec);
  return Math.max(0, end - start);
}

/**
 * Find audio-lane clips that overlap a visual range (half-open).
 * Prefer greatest overlap; timeline array order breaks ties.
 */
export function findOverlappingAudioClip(
  clips: readonly TimelineClip[],
  visual: Interval,
): TimelineClip | null {
  let best: TimelineClip | null = null;
  let bestOverlap = 0;
  for (const clip of clips) {
    if (clip.lane !== "audio") continue;
    if (!(clip.startSec < visual.endSec && clip.endSec > visual.startSec)) {
      continue;
    }
    const overlap = overlapDurationSec(visual, {
      startSec: clip.startSec,
      endSec: clip.endSec,
    });
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = clip;
    }
  }
  return best;
}
