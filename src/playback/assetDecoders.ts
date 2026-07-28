import type { TimelineClip } from "../project/types";
import { clipHasFreshExtendBake } from "../layouts/editor/clipExtendBake";
import { clipInSec } from "../layouts/editor/timelineCompose";

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
};

/** Every unique video/image backing asset on the video lane. */
export function listVisualDecoders(
  clips: readonly TimelineClip[],
): VisualDecoderMeta[] {
  const byKey = new Map<AssetDecoderKey, VisualDecoderMeta>();
  for (const clip of clips) {
    if (clip.lane === "audio") continue;
    if (clip.kind === "audio") continue;
    if (clip.kind === "slideshow") {
      const key = assetDecoderKey(clip);
      byKey.set(key, {
        key,
        kind: "slideshow",
        bakePath: clip.bakePath ?? null,
      });
      continue;
    }
    if (!clip.assetId?.trim()) continue;
    if (clip.kind === "video" && clipHasFreshExtendBake(clip)) {
      const key = assetDecoderKey(clip);
      byKey.set(key, {
        key,
        kind: "video",
        extendBakePath: clip.extendBakePath ?? null,
        clipId: clip.id,
      });
      continue;
    }
    const kind = clip.kind === "image" ? "image" : "video";
    const key = assetDecoderKey(clip);
    // Prefer video if the same key ever appears as both (shouldn't).
    const prev = byKey.get(key);
    if (!prev || (prev.kind === "image" && kind === "video")) {
      byKey.set(key, { key, kind });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
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
      map.set(key, clip.kind === "slideshow" ? 0 : clipInSec(clip));
    }
  }
  return map;
}
