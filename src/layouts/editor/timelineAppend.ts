export type TimelineInterval = {
  startSec: number;
  endSec: number;
  lane?: "video" | "audio";
};

/** Lane used for placement / overlap checks (default video). */
export function clipLane(clip: {
  lane?: "video" | "audio";
}): "video" | "audio" {
  return clip.lane === "audio" ? "audio" : "video";
}

/** End of the last clip on a lane (0 when empty) — append point with no overlap. */
export function laneAppendStartSec(
  laneClips: readonly TimelineInterval[],
): number {
  if (laneClips.length === 0) return 0;
  let maxEnd = 0;
  for (const clip of laneClips) {
    const end = Number(clip.endSec);
    if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
  }
  return Math.max(0, maxEnd);
}

/**
 * Start time for pasting a clipboard group so every clip lands after existing
 * content on its lane, preserving relative offsets within the group.
 * Scans from the end of each lane backward to the first non-overlapping pack.
 */
export function pasteAppendStartSec(
  existing: readonly TimelineInterval[],
  sources: readonly TimelineInterval[],
): number {
  if (sources.length === 0) return 0;
  const origin = Math.min(...sources.map((c) => c.startSec));
  let startBase = 0;
  for (const source of sources) {
    const lane = clipLane(source);
    const laneClips = existing.filter((c) => clipLane(c) === lane);
    const laneEnd = laneAppendStartSec(laneClips);
    const rel = source.startSec - origin;
    startBase = Math.max(startBase, laneEnd - rel);
  }
  return Math.max(0, startBase);
}
