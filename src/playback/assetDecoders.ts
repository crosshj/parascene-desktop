import type { TimelineClip } from "../project/types";
import { clipHasFreshExtendBake, extendBakeSourceSec } from "../layouts/editor/clipExtendBake";
import {
  clipInSec,
  clipSourceSec,
  peekNextVisualClip,
  peekPrevVisualClip,
  resolveTimelineFrame,
} from "../layouts/editor/timelineCompose";

/** Unique decoder identity: one DOM media element per asset × direction. */
export type AssetDecoderKey = string;

export function assetDecoderKey(clip: TimelineClip): AssetDecoderKey {
  if (clip.kind === "slideshow") {
    const bake = clip.bakeKey?.trim() || clip.bakePath?.trim() || "pending";
    return `slideshow:${clip.id}:${bake}`;
  }
  if (clip.kind === "video" && clipHasFreshExtendBake(clip)) {
    const bake = clip.extendBakeKey?.trim() || clip.extendBakePath?.trim() || "pending";
    return `extend:${clip.id}:${bake}`;
  }
  const assetId = clip.assetId?.trim() || clip.id;
  return `${assetId}:${clip.reverse ? "r" : "f"}`;
}

export function isSlideshowKey(key: AssetDecoderKey): boolean {
  return key.startsWith("slideshow:");
}

export function isExtendKey(key: AssetDecoderKey): boolean {
  return key.startsWith("extend:");
}

export function assetIdFromKey(key: AssetDecoderKey): string {
  if (isSlideshowKey(key)) return "";
  const idx = key.lastIndexOf(":");
  return idx >= 0 ? key.slice(0, idx) : key;
}

export function isReverseKey(key: AssetDecoderKey): boolean {
  if (isSlideshowKey(key)) return false;
  return key.endsWith(":r");
}

export type VisualDecoderMeta = {
  key: AssetDecoderKey;
  kind: "video" | "image" | "slideshow";
  bakePath?: string | null;
  extendBakePath?: string | null;
  clipId?: string;
  /** Upcoming-park target: source in-point, or 0 for bake files. */
  parkStartSec?: number;
};

export function visualDecoderMeta(
  clip: TimelineClip,
): VisualDecoderMeta | null {
  if (clip.lane === "audio" || clip.kind === "audio") return null;
  if (clip.kind === "slideshow") {
    const key = assetDecoderKey(clip);
    return {
      key,
      kind: "slideshow",
      bakePath: clip.bakePath ?? null,
      parkStartSec: 0,
    };
  }
  if (!clip.assetId?.trim()) return null;
  if (clip.kind === "video" && clipHasFreshExtendBake(clip)) {
    const key = assetDecoderKey(clip);
    return {
      key,
      kind: "video",
      extendBakePath: clip.extendBakePath ?? null,
      clipId: clip.id,
      parkStartSec: 0,
    };
  }
  const kind = clip.kind === "image" ? "image" : "video";
  const key = assetDecoderKey(clip);
  return { key, kind, parkStartSec: clipInSec(clip) };
}

/** Every unique video/image backing asset on the video lane. */
export function listVisualDecoders(
  clips: readonly TimelineClip[],
): VisualDecoderMeta[] {
  const byKey = new Map<AssetDecoderKey, VisualDecoderMeta>();
  for (const clip of clips) {
    const meta = visualDecoderMeta(clip);
    if (!meta) continue;
    const prev = byKey.get(meta.key);
    if (!prev || (prev.kind === "image" && meta.kind === "video")) {
      byKey.set(meta.key, meta);
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export type VisualBufferWindow = {
  prev: TimelineClip | null;
  current: TimelineClip | null;
  next: TimelineClip | null;
};

/** Previous / covering / next video-lane clips around timeline time `t`. */
export function visualBufferWindow(
  clips: readonly TimelineClip[],
  t: number,
): VisualBufferWindow {
  return {
    prev: peekPrevVisualClip(clips, t),
    current: resolveTimelineFrame(clips, t).visual?.clip ?? null,
    next: peekNextVisualClip(clips, t),
  };
}

/** Decoder metas for the playhead buffer window (prev / current / next). */
export function bufferWindowVisualDecoders(
  clips: readonly TimelineClip[],
  t: number,
): VisualDecoderMeta[] {
  const { prev, current, next } = visualBufferWindow(clips, t);
  const byKey = new Map<AssetDecoderKey, VisualDecoderMeta>();
  for (const clip of [prev, current, next]) {
    if (!clip) continue;
    const meta = visualDecoderMeta(clip);
    if (!meta) continue;
    const existing = byKey.get(meta.key);
    if (!existing || (existing.kind === "image" && meta.kind === "video")) {
      byKey.set(meta.key, meta);
    }
  }
  return [...byKey.values()];
}

function parkSecForClip(clip: TimelineClip, at: "start" | "end"): number {
  if (clip.kind === "slideshow") return 0;
  if (clipHasFreshExtendBake(clip)) {
    if (at === "start") return 0;
    const endT = Math.max(clip.startSec, clip.endSec - 1 / 60);
    return extendBakeSourceSec(clip, endT);
  }
  if (at === "start") return clipInSec(clip);
  const endT = Math.max(clip.startSec, clip.endSec - 1 / 60);
  return clipSourceSec(clip, endT);
}

/**
 * Park standby decoders in the buffer window: upcoming clip at its in-point
 * (bake time 0 for extend files), previous clip at its last source frame.
 */
export function bufferWindowParkByKey(
  clips: readonly TimelineClip[],
  t: number,
): Map<AssetDecoderKey, number> {
  const { prev, next } = visualBufferWindow(clips, t);
  const map = new Map<AssetDecoderKey, number>();
  if (next) {
    const meta = visualDecoderMeta(next);
    if (meta) map.set(meta.key, parkSecForClip(next, "start"));
  }
  if (prev) {
    const meta = visualDecoderMeta(prev);
    if (meta && !map.has(meta.key)) {
      map.set(meta.key, parkSecForClip(prev, "end"));
    }
  }
  return map;
}

/**
 * Park each standby decoder on the earliest in-point for that asset×direction.
 * Keeps cold slots off frame 0 so the first scrub cut doesn't flash.
 */
export function parkSourceByKey(
  clips: readonly TimelineClip[],
): Map<AssetDecoderKey, number> {
  const map = new Map<AssetDecoderKey, number>();
  const videoClips = clips
    .filter((c) => c.lane !== "audio")
    .filter((c) => c.kind !== "audio")
    .filter(
      (c) =>
        c.kind === "slideshow" || Boolean(c.assetId?.trim()),
    )
    .slice()
    .sort(
      (a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id),
    );
  for (const clip of videoClips) {
    const key = assetDecoderKey(clip);
    if (!map.has(key)) {
      map.set(
        key,
        clip.kind === "slideshow" || clipHasFreshExtendBake(clip)
          ? 0
          : clipInSec(clip),
      );
    }
  }
  return map;
}
