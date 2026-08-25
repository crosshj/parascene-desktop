import type { TimelineClip } from "../../project/types";
import {
  clipExtendSourceSpanSec,
  clipInSec,
  clipIsTimelineExtended,
  clipOutSec,
  clipPlaythroughUnitSec,
  clipSpeed,
  clipTimelineDurationSec,
} from "./timelineCompose";

function roundBakeSec(sec: number): number {
  return Math.round(sec * 1000) / 1000;
}

/**
 * Recipe fingerprint for an extend bake (trim, ping-pong, reverse, asset).
 * Speed is omitted: the bake is ordinary 1× loop/pong video. Playback
 * free-runs it with `playbackRate = clip speed` (same as any other clip).
 */
export function computeExtendBakeKey(clip: TimelineClip): string | null {
  if (!clipIsTimelineExtended(clip)) return null;
  const assetId = clip.assetId?.trim();
  if (!assetId) return null;
  const inSec = clipInSec(clip);
  const outSec = clipOutSec(clip);
  if (!(outSec > inSec)) return null;
  return JSON.stringify({
    v: 7,
    assetId,
    inSec: roundBakeSec(inSec),
    outSec: roundBakeSec(outSec),
    pingPong: clip.extendPingPong === true,
    reverse: clip.reverse === true,
  });
}

/**
 * Disk cache length in 1× media time: enough loop/pong material so that
 * playing at the clip's speed covers the timeline placement
 * (`cover / speed >= timelineDuration`).
 */
export function computeExtendBakeTargetSec(clip: TimelineClip): number | null {
  if (!clipIsTimelineExtended(clip)) return null;
  const sourceSpan = clipExtendSourceSpanSec(clip);
  if (!sourceSpan) return null;
  const timelineDur = clipTimelineDurationSec(clip);
  const speed = clipSpeed(clip);
  const mediaNeeded = timelineDur * speed;
  const spans = Math.max(1, Math.ceil(mediaNeeded / sourceSpan - 1e-9));
  return Math.round(spans * sourceSpan * 1000) / 1000;
}

/** 1× bake seconds that must be present to cover the timeline at current speed. */
export function clipExtendBakeCoverNeededSec(clip: TimelineClip): number {
  return Math.round(clipTimelineDurationSec(clip) * clipSpeed(clip) * 1000) / 1000;
}

/**
 * Playhead position inside the bake file. The bake starts at 0 and is 1×
 * media; clip speed is applied via playbackRate, so bake time is
 * `localSec × speed` (same mapping as a normal clip with in-point 0).
 */
export function extendBakeSourceSec(
  clip: TimelineClip,
  timelineSec: number,
): number {
  const local = Math.max(0, timelineSec - clip.startSec);
  return local * clipSpeed(clip);
}

/** Current clip settings match the baked recipe and cached cover fits at speed. */
export function clipHasFreshExtendBake(clip: TimelineClip): boolean {
  if (!clipIsTimelineExtended(clip)) return false;
  if (clip.reverse) return false;
  const key = computeExtendBakeKey(clip);
  if (!key || !clip.extendBakePath?.trim()) return false;
  if (clip.extendBakeKey !== key) return false;
  const cover = clip.extendBakeCoverSec;
  if (!(cover != null && Number.isFinite(cover) && cover > 0)) return false;
  return cover + 0.001 >= clipExtendBakeCoverNeededSec(clip);
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
  const playthrough = clipPlaythroughUnitSec(clip);
  if (!(playthrough > 0)) return [];
  const timelineDur = clipTimelineDurationSec(clip);
  const fracs: number[] = [];
  for (let t = 2 * playthrough; t < timelineDur - 1e-6; t += playthrough) {
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
  const playthrough = clipPlaythroughUnitSec(clip);
  if (!(playthrough > 0)) return [];
  const timelineDur = clipTimelineDurationSec(clip);
  const segments: ExtendSegmentRange[] = [];
  for (let i = 0; ; i += 2) {
    const start = playthrough + i * playthrough;
    if (start >= timelineDur - 1e-6) break;
    const end = Math.min(playthrough + (i + 1) * playthrough, timelineDur);
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
