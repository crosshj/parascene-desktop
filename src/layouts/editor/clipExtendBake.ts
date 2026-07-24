import type { TimelineClip } from "../../project/types";
import {
  clipExtendSourceSpanSec,
  clipInSec,
  clipIsTimelineExtended,
  clipOutSec,
  clipTimelineDurationSec,
} from "./timelineCompose";

function roundBakeSec(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * Recipe fingerprint for an extend bake (trim, ping-pong, reverse, asset).
 * Stored on the clip as `extendBakeKey` after a successful bake.
 */
export function computeExtendBakeKey(clip: TimelineClip): string | null {
  if (!clipIsTimelineExtended(clip)) return null;
  const assetId = clip.assetId?.trim();
  if (!assetId) return null;
  const inSec = clipInSec(clip);
  const outSec = clipOutSec(clip);
  if (!(outSec > inSec)) return null;
  return JSON.stringify({
    v: 5,
    assetId,
    inSec: roundBakeSec(inSec),
    outSec: roundBakeSec(outSec),
    pingPong: clip.extendPingPong === true,
    reverse: clip.reverse === true,
  });
}

/**
 * Disk cache length: the smallest whole number of source repeat units that
 * covers the current timeline placement.
 */
export function computeExtendBakeTargetSec(clip: TimelineClip): number | null {
  if (!clipIsTimelineExtended(clip)) return null;
  const sourceSpan = clipExtendSourceSpanSec(clip);
  if (!sourceSpan) return null;
  const timelineDur = clipTimelineDurationSec(clip);
  const spans = Math.max(1, Math.ceil(timelineDur / sourceSpan));
  return roundBakeSec(spans * sourceSpan);
}

/** Current clip settings match the baked recipe and cached cover fits the timeline. */
export function clipHasFreshExtendBake(clip: TimelineClip): boolean {
  if (!clipIsTimelineExtended(clip)) return false;
  if (clip.reverse) return false;
  const key = computeExtendBakeKey(clip);
  if (!key || !clip.extendBakePath?.trim()) return false;
  if (clip.extendBakeKey !== key) return false;
  const cover = clip.extendBakeCoverSec;
  if (!(cover != null && Number.isFinite(cover) && cover > 0)) return false;
  return clipTimelineDurationSec(clip) <= cover + 0.001;
}

/** Extended clip needs a bake (or rebake) before monitor/export can use a cached extend file. */
export function clipNeedsExtendBake(clip: TimelineClip): boolean {
  if (!clipIsTimelineExtended(clip)) return false;
  if (clip.reverse) return false;
  return !clipHasFreshExtendBake(clip);
}

/** 0..1 positions of repeat boundaries after the source-trim divit. */
export function clipExtendLoopLineFractions(clip: TimelineClip): number[] {
  if (!clipIsTimelineExtended(clip)) return [];
  const sourceSpan = clipExtendSourceSpanSec(clip);
  if (!sourceSpan) return [];
  const timelineDur = clipTimelineDurationSec(clip);
  const fracs: number[] = [];
  for (let t = 2 * sourceSpan; t < timelineDur - 1e-6; t += sourceSpan) {
    fracs.push(t / timelineDur);
  }
  return fracs;
}

export type ExtendSegmentRange = { left: number; width: number };

/** Pong (reverse) spans in the extended tail for ping-pong mode. */
export function clipExtendPongSegmentFractions(
  clip: TimelineClip,
): ExtendSegmentRange[] {
  if (!clipIsTimelineExtended(clip) || clip.extendPingPong !== true) return [];
  const sourceSpan = clipExtendSourceSpanSec(clip);
  if (!sourceSpan) return [];
  const timelineDur = clipTimelineDurationSec(clip);
  const segments: ExtendSegmentRange[] = [];
  for (let i = 0; ; i += 2) {
    const start = sourceSpan + i * sourceSpan;
    if (start >= timelineDur - 1e-6) break;
    const end = Math.min(sourceSpan + (i + 1) * sourceSpan, timelineDur);
    if (end <= start + 1e-6) break;
    segments.push({ left: start / timelineDur, width: (end - start) / timelineDur });
  }
  return segments;
}

/**
 * Keep prior bake metadata while the clip stays extended. Freshness is decided
 * by comparing `computeExtendBakeKey` to the stored `extendBakeKey`.
 */
export function mergeExtendBakeFields(
  prev: TimelineClip,
  next: TimelineClip,
): Pick<TimelineClip, "extendBakeKey" | "extendBakePath" | "extendBakeCoverSec"> {
  if (!clipIsTimelineExtended(next)) {
    return {
      extendBakeKey: undefined,
      extendBakePath: undefined,
      extendBakeCoverSec: undefined,
    };
  }
  return {
    extendBakeKey: prev.extendBakeKey,
    extendBakePath: prev.extendBakePath,
    extendBakeCoverSec: prev.extendBakeCoverSec,
  };
}
