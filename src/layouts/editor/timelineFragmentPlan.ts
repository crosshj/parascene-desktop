import type { TimelineClip } from "../../project/types";
import {
  DEFAULT_PREVIEW_QUALITY,
  type PreviewQuality,
} from "../../settings/previewQuality";

/** Preview fragments: 2s closed GOPs. Plan/cut grid stays 30fps; encode is much coarser. */
export const FRAGMENT_DURATION_SEC = 2;
export const FRAGMENT_FPS = 30;
export const FRAGMENT_FRAMES = FRAGMENT_DURATION_SEC * FRAGMENT_FPS;
/** Bump when preview encode params change so stale fMP4 cache is dropped. */
const PREVIEW_ENCODE_TAG = "pv-cmaf5";
/** One frame of neighbor overlap so cuts on a boundary dirty both sides. */
export const FRAGMENT_NEIGHBOR_PAD_SEC = 1 / FRAGMENT_FPS;
/** Next chunk must be ready this far before the current one ends. */
export const FRAGMENT_PLAYBACK_LOOKAHEAD_SEC = 0.2;

export type TimelineFragmentSpec = {
  index: number;
  startSec: number;
  durationSec: number;
  /** Clip ids that contribute pixels to this fragment (including neighbor pad). */
  clipIds: string[];
  fingerprint: string;
};

export type TimelineFragmentPlan = {
  aspectRatio: string;
  durationSec: number;
  fragmentCount: number;
  fragments: TimelineFragmentSpec[];
};

function quantizeSec(sec: number): number {
  return Math.round(sec * 1000);
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clipLane(clip: TimelineClip): "video" | "audio" {
  return clip.lane === "audio" ? "audio" : "video";
}

function rangesOverlap(
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): boolean {
  return a0 < b1 && b0 < a1;
}

/**
 * End of picture content on the timeline. Audio beds past this do not need
 * preview fragments — the monitor goes black and audio keeps playing.
 */
export function timelineVideoExtentSec(clips: readonly TimelineClip[]): number {
  let max = 0;
  for (const clip of clips) {
    if (clipLane(clip) !== "video") continue;
    if (Number.isFinite(clip.endSec)) max = Math.max(max, clip.endSec);
  }
  return max;
}

/**
 * Whether this clip can contribute real pixels to a preview bake.
 * Placeholders and clips without media bake as black until they become ready;
 * the readiness bit in the fingerprint re-dirties those fragments.
 */
export function clipPreviewMediaReady(
  clip: TimelineClip,
  localAssetIds?: ReadonlySet<string> | null,
): boolean {
  if (clip.isAddAssetPlaceholder === true) return false;
  if (clip.bakePath?.trim()) return true;
  if (clip.extendBakePath?.trim()) return true;
  const assetId = clip.assetId?.trim();
  if (!assetId) return false;
  // Unknown locality: optimistic so a first plan matches existing clips.
  if (!localAssetIds) return true;
  return localAssetIds.has(assetId);
}

function visualClipKey(
  clip: TimelineClip,
  localAssetIds?: ReadonlySet<string> | null,
): string {
  const slideshow = clip.slideshow;
  return [
    clip.id,
    clip.assetId ?? "",
    clip.kind ?? "",
    clip.framing ?? "",
    clip.transform ?? "",
    clip.reverse === true ? "1" : "0",
    clip.extendPingPong === true ? "1" : "0",
    quantizeSec(clip.startSec),
    quantizeSec(clip.endSec),
    quantizeSec(clip.inSec ?? 0),
    quantizeSec(clip.outSec ?? 0),
    quantizeSec(clip.speed ?? 1),
    quantizeSec(clip.zoom ?? 1),
    quantizeSec(clip.centerX ?? 0),
    quantizeSec(clip.centerY ?? 0),
    quantizeSec(clip.extendSourceSpanSec ?? 0),
    clip.bakePath ?? "",
    clip.extendBakePath ?? "",
    clipPreviewMediaReady(clip, localAssetIds) ? "1" : "0",
    slideshow
      ? [
          slideshow.mode,
          slideshow.imageAssetIds.join(","),
          slideshow.audioAssetId ?? "",
          slideshow.random === true ? "1" : "0",
          slideshow.seed ?? "",
          quantizeSec(slideshow.sensitivity ?? 0),
        ].join(";")
      : "",
  ].join("|");
}

export function sequenceFrameCount(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.max(0, Math.round(durationSec * FRAGMENT_FPS));
}

export function fragmentStartFrame(index: number): number {
  return index * FRAGMENT_FRAMES;
}

export function fragmentRange(
  index: number,
  totalFrames: number,
): { startFrame: number; endFrame: number } {
  const startFrame = fragmentStartFrame(index);
  const endFrame = Math.min(startFrame + FRAGMENT_FRAMES, totalFrames);
  return { startFrame, endFrame };
}

/**
 * True when this fragment can keep presenting through `sec` without stalling:
 * enough time left in the chunk, or the next cadence slot is already ready.
 */
export function fragmentPlaybackHasContinuity(args: {
  sec: number;
  sequenceEndSec: number;
  covering: { startSec: number; durationSec: number } | null;
  nextReady: boolean;
  lookaheadSec?: number;
}): boolean {
  const covering = args.covering;
  if (!covering) return false;
  const lookahead = args.lookaheadSec ?? FRAGMENT_PLAYBACK_LOOKAHEAD_SEC;
  const nextStart = covering.startSec + covering.durationSec;
  if (nextStart >= args.sequenceEndSec - 1e-3) return true;
  if (nextStart - args.sec > lookahead) return true;
  return args.nextReady;
}

export function fragmentIndexAtSec(sec: number, totalFrames: number): number {
  if (totalFrames <= 0) return 0;
  const frame = Math.min(
    totalFrames - 1,
    Math.max(0, Math.floor(sec * FRAGMENT_FPS + 1e-9)),
  );
  return Math.floor(frame / FRAGMENT_FRAMES);
}

export function contributingVisualClips(
  clips: readonly TimelineClip[],
  startSec: number,
  endSec: number,
): TimelineClip[] {
  const from = startSec - FRAGMENT_NEIGHBOR_PAD_SEC;
  const to = endSec + FRAGMENT_NEIGHBOR_PAD_SEC;
  return clips.filter(
    (clip) =>
      clipLane(clip) === "video" &&
      rangesOverlap(clip.startSec, clip.endSec, from, to),
  );
}

/** Clips this fragment can render from — independent of the rest of the sequence. */
export function clipsForFragment(
  clips: readonly TimelineClip[],
  spec: Pick<TimelineFragmentSpec, "startSec" | "durationSec">,
): TimelineClip[] {
  return contributingVisualClips(
    clips,
    spec.startSec,
    spec.startSec + spec.durationSec,
  );
}

/**
 * Lower is more urgent. Current fragment first, then next, then previous,
 * then distance from the playhead.
 */
export function fragmentJobPriority(
  index: number,
  playheadIndex: number,
): number {
  if (index === playheadIndex) return 0;
  if (index === playheadIndex + 1) return 1;
  if (index === playheadIndex - 1) return 2;
  return Math.abs(index - playheadIndex) + 2;
}

export function planTimelineFragments(
  clips: readonly TimelineClip[],
  aspectRatio: string,
  durationSec = timelineVideoExtentSec(clips),
  quality: PreviewQuality = DEFAULT_PREVIEW_QUALITY,
  localAssetIds?: ReadonlySet<string> | null,
): TimelineFragmentPlan {
  const totalFrames = sequenceFrameCount(durationSec);
  const fragmentCount =
    totalFrames <= 0 ? 0 : Math.ceil(totalFrames / FRAGMENT_FRAMES);
  const aspect = aspectRatio.trim() || "16:9";
  const fragments: TimelineFragmentSpec[] = [];

  for (let index = 0; index < fragmentCount; index += 1) {
    const { startFrame, endFrame } = fragmentRange(index, totalFrames);
    const startSec = startFrame / FRAGMENT_FPS;
    const duration = (endFrame - startFrame) / FRAGMENT_FPS;
    const contributors = contributingVisualClips(
      clips,
      startSec,
      startSec + duration,
    );
    const fingerprint = fnv1a32(
      [
        PREVIEW_ENCODE_TAG,
        quality,
        aspect,
        index,
        startFrame,
        endFrame,
        ...contributors.map((c) => visualClipKey(c, localAssetIds)),
      ].join("/"),
    );
    fragments.push({
      index,
      startSec,
      durationSec: duration,
      clipIds: contributors.map((clip) => clip.id),
      fingerprint,
    });
  }

  return {
    aspectRatio: aspect,
    durationSec: totalFrames / FRAGMENT_FPS,
    fragmentCount,
    fragments,
  };
}

export function dirtyFragmentIndices(
  prev: TimelineFragmentPlan | null,
  next: TimelineFragmentPlan,
): number[] {
  const dirty: number[] = [];
  const prevByIndex = new Map(
    (prev?.fragments ?? []).map((frag) => [frag.index, frag]),
  );
  for (const frag of next.fragments) {
    const was = prevByIndex.get(frag.index);
    if (!was || was.fingerprint !== frag.fingerprint) dirty.push(frag.index);
  }
  return dirty;
}
