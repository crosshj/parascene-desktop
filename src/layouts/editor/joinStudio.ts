import type { TimelineClip } from "../../project/types";

/** Export / join clock — matches render.rs CFR. */
export const JOIN_FPS = 30;

/** Max gap between A.end and B.start for Join Studio eligibility. */
export const JOIN_MAX_GAP_SEC = 1;

/** Default FFmpeg preview half-window around the seam. */
export const JOIN_PREVIEW_HALF_WINDOW_SEC = 0.75;

export type JoinStrategy = "hard_cut" | "hold" | "fill" | "crossfade";

export type JoinHoldSide = "A" | "B";
export type JoinFillFrom = "A" | "B" | "both";

export type JoinStudioParams = {
  strategy: JoinStrategy;
  /** Frames added to clip A outSec (negative = earlier out). */
  nudgeAOutFrames: number;
  /** Frames added to clip B inSec (negative = earlier in). */
  nudgeBInFrames: number;
  holdSide: JoinHoldSide;
  holdFrames: number;
  removeGap: boolean;
  fillFrom: JoinFillFrom;
  fillFrames: number;
  xfadeFrames: number;
};

export type JoinableTimelinePair = {
  clipA: TimelineClip;
  clipB: TimelineClip;
  startSec: number;
  endSec: number;
  /** Timeline gap between A end and B start (0 if abutting / micro-overlap within epsilon). */
  gapSec: number;
};

export function framesToSec(frames: number): number {
  return frames / JOIN_FPS;
}

export function secToFrames(sec: number): number {
  return Math.round(sec * JOIN_FPS);
}

export function defaultJoinStudioParams(gapSec: number): JoinStudioParams {
  return {
    strategy: "hard_cut",
    nudgeAOutFrames: 0,
    nudgeBInFrames: 0,
    holdSide: "A",
    holdFrames: 3,
    removeGap: gapSec > 1 / JOIN_FPS,
    fillFrom: "A",
    fillFrames: Math.max(1, secToFrames(gapSec) || 3),
    xfadeFrames: 6,
  };
}

function compareTimelineClips(a: TimelineClip, b: TimelineClip): number {
  return a.startSec - b.startSec || a.endSec - b.endSec || a.id.localeCompare(b.id);
}

function isVideoLaneClip(clip: TimelineClip): boolean {
  return (clip.lane ?? "video") === "video";
}

function isJoinableVideoClip(clip: TimelineClip): boolean {
  return isVideoLaneClip(clip) && clip.kind === "video" && Boolean(clip.assetId);
}

function clipInSec(clip: TimelineClip): number {
  return Number.isFinite(clip.inSec) ? Math.max(0, Number(clip.inSec)) : 0;
}

function clipOutSec(clip: TimelineClip): number {
  if (Number.isFinite(clip.outSec)) return Math.max(clipInSec(clip) + 0.1, Number(clip.outSec));
  return clipInSec(clip) + Math.max(0.1, clip.endSec - clip.startSec);
}

/**
 * Exactly two selected video clips on the video lane, ordered in time,
 * with gap in [0, JOIN_MAX_GAP_SEC] and no overlap.
 */
export function getJoinableTimelinePair(
  timeline: TimelineClip[],
  selectedClipIds: readonly string[],
): JoinableTimelinePair | null {
  if (selectedClipIds.length !== 2) return null;
  const selectedIdSet = new Set(selectedClipIds);
  const clips = timeline
    .filter((clip) => selectedIdSet.has(clip.id))
    .sort(compareTimelineClips);
  if (clips.length !== 2) return null;
  const [clipA, clipB] = clips;
  if (!clipA || !clipB) return null;
  if (!isJoinableVideoClip(clipA) || !isJoinableVideoClip(clipB)) return null;
  if ((clipA.lane ?? "video") !== (clipB.lane ?? "video")) return null;

  const gapSec = clipB.startSec - clipA.endSec;
  if (gapSec < -1e-6) return null; // overlap
  if (gapSec > JOIN_MAX_GAP_SEC) return null;

  return {
    clipA,
    clipB,
    startSec: clipA.startSec,
    endSec: clipB.endSec,
    gapSec: Math.max(0, gapSec),
  };
}

export function effectiveTrim(
  clip: TimelineClip,
  side: "A" | "B",
  params: JoinStudioParams,
): { inSec: number; outSec: number } {
  const inSec = clipInSec(clip);
  const outSec = clipOutSec(clip);
  if (side === "A") {
    const nextOut = outSec + framesToSec(params.nudgeAOutFrames);
    return {
      inSec,
      outSec: Math.max(inSec + 1 / JOIN_FPS, nextOut),
    };
  }
  const nextIn = inSec + framesToSec(params.nudgeBInFrames);
  return {
    inSec: Math.max(0, Math.min(nextIn, outSec - 1 / JOIN_FPS)),
    outSec,
  };
}

/** Encoded media duration for the chosen strategy (seconds). */
export function joinEncodedDurationSec(
  pair: JoinableTimelinePair,
  params: JoinStudioParams,
): number {
  const a = effectiveTrim(pair.clipA, "A", params);
  const b = effectiveTrim(pair.clipB, "B", params);
  const aDur = Math.max(1 / JOIN_FPS, a.outSec - a.inSec);
  const bDur = Math.max(1 / JOIN_FPS, b.outSec - b.inSec);

  switch (params.strategy) {
    case "hard_cut":
      return aDur + bDur;
    case "hold":
      return aDur + framesToSec(Math.max(0, params.holdFrames)) + bDur;
    case "fill": {
      const fillSec = framesToSec(Math.max(0, params.fillFrames));
      return aDur + fillSec + bDur;
    }
    case "crossfade": {
      const xfadeSec = Math.min(
        framesToSec(Math.max(1, params.xfadeFrames)),
        aDur - 1 / JOIN_FPS,
        bDur - 1 / JOIN_FPS,
      );
      return Math.max(1 / JOIN_FPS, aDur + bDur - Math.max(0, xfadeSec));
    }
    default:
      return aDur + bDur;
  }
}

/** Timeline span after commit: starts at pair.startSec, length = encoded duration. */
export function joinReplacementSpan(
  pair: JoinableTimelinePair,
  params: JoinStudioParams,
): { startSec: number; endSec: number; durationSec: number } {
  const durationSec = joinEncodedDurationSec(pair, params);
  const startSec = pair.startSec;
  return {
    startSec,
    endSec: startSec + durationSec,
    durationSec,
  };
}

export function joinParamsFingerprint(params: JoinStudioParams): string {
  return [
    params.strategy,
    params.nudgeAOutFrames,
    params.nudgeBInFrames,
    params.holdSide,
    params.holdFrames,
    params.removeGap ? 1 : 0,
    params.fillFrom,
    params.fillFrames,
    params.xfadeFrames,
  ].join(":");
}

export { clipInSec, clipOutSec };
