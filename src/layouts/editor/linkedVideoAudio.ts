/**
 * Video "Include Audio" companions on the Master Audio lane.
 *
 * When a video clip has includeAudio, a linked audio-lane clip mirrors its
 * placement/trim so editors can see and group-move it like other NLEs.
 */

import type { TimelineClip } from "../../project/types";

function newCompanionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isLinkedVideoAudioClip(clip: TimelineClip): boolean {
  return (
    Boolean(clip.linkedVideoClipId?.trim()) &&
    (clip.lane === "audio" || clip.kind === "audio")
  );
}

export function videoWantsLinkedAudio(clip: TimelineClip): boolean {
  return (
    (clip.kind === "video" ||
      ((clip.lane ?? "video") === "video" &&
        clip.kind !== "image" &&
        clip.kind !== "slideshow" &&
        clip.kind !== "audio")) &&
    clip.includeAudio === true &&
    Boolean(clip.assetId?.trim()) &&
    clip.isAddAssetPlaceholder !== true
  );
}

/**
 * Monitor soundtrack comes from the V1 video element (already in the buffer
 * window) instead of opening that same file in a second audio decoder.
 *
 * True when Include Audio wins the mix: linked A1 companion of the covering
 * video, or A1 empty with includeAudio. False for A1 beds and slideshows.
 */
export function videoElementCarriesMonitorAudio(
  visual: TimelineClip | null,
  winningAudio: TimelineClip | null,
): boolean {
  if (!visual) return false;
  if (visual.kind === "image" || visual.kind === "slideshow") return false;

  if (
    winningAudio &&
    isLinkedVideoAudioClip(winningAudio) &&
    winningAudio.linkedVideoClipId === visual.id
  ) {
    return true;
  }
  if (!winningAudio && visual.includeAudio === true) return true;
  return false;
}

export function findLinkedAudioForVideo(
  clips: readonly TimelineClip[],
  videoId: string,
): TimelineClip | undefined {
  return clips.find(
    (c) => isLinkedVideoAudioClip(c) && c.linkedVideoClipId === videoId,
  );
}

/** Build or refresh the Master Audio companion for a video clip. */
export function buildLinkedAudioCompanion(
  video: TimelineClip,
  existing?: TimelineClip,
): TimelineClip {
  const duration = Math.max(0.1, video.endSec - video.startSec);
  const label =
    Number.isFinite(duration) && duration > 0
      ? `${(Math.round(duration * 10) / 10).toFixed(1)}s`
      : video.label;
  return {
    id: existing?.id ?? newCompanionId(),
    label,
    startSec: video.startSec,
    endSec: video.startSec + duration,
    assetId: video.assetId,
    thumbUrl: video.thumbUrl ?? null,
    lane: "audio",
    kind: "audio",
    inSec: video.inSec,
    outSec: video.outSec,
    includeAudio: false,
    reverse: video.reverse,
    speed: video.speed,
    extendPingPong: video.extendPingPong,
    extendSourceSpanSec: video.extendSourceSpanSec,
    linkedVideoClipId: video.id,
  };
}

/**
 * Ensure companions exist for includeAudio videos, stay timing-synced, and
 * drop orphans. Idempotent.
 */
export function syncLinkedVideoAudio(
  clips: readonly TimelineClip[],
): TimelineClip[] {
  const existingByVideoId = new Map<string, TimelineClip>();
  for (const clip of clips) {
    const videoId = clip.linkedVideoClipId?.trim();
    if (!videoId || !isLinkedVideoAudioClip(clip)) continue;
    if (!existingByVideoId.has(videoId)) {
      existingByVideoId.set(videoId, clip);
    }
  }

  const out: TimelineClip[] = [];
  for (const clip of clips) {
    if (isLinkedVideoAudioClip(clip)) continue;
    out.push(clip);
    if (!videoWantsLinkedAudio(clip)) continue;
    out.push(buildLinkedAudioCompanion(clip, existingByVideoId.get(clip.id)));
  }
  return out;
}

/** Expand a move/selection set so video↔companion stay glued. */
export function expandLinkedMoveIds(
  clips: readonly TimelineClip[],
  ids: readonly string[],
): string[] {
  const idSet = new Set(ids);
  const byId = new Map(clips.map((c) => [c.id, c]));
  for (const id of ids) {
    const clip = byId.get(id);
    if (!clip) continue;
    if (clip.includeAudio === true || videoWantsLinkedAudio(clip)) {
      const companion = findLinkedAudioForVideo(clips, clip.id);
      if (companion) idSet.add(companion.id);
    }
    const parentId = clip.linkedVideoClipId?.trim();
    if (parentId && isLinkedVideoAudioClip(clip)) {
      idSet.add(parentId);
    }
  }
  return [...idSet];
}

/**
 * Delete clips while keeping includeAudio companions consistent.
 * Deleting a video removes its companion; deleting only the companion turns
 * Include Audio off on the parent video.
 */
export function removeClipsWithLinkedAudio(
  clips: readonly TimelineClip[],
  ids: ReadonlySet<string>,
): TimelineClip[] {
  const remove = new Set(ids);
  let next = clips.map((c) => ({ ...c }));

  for (const clip of clips) {
    if (!ids.has(clip.id)) continue;
    if (isLinkedVideoAudioClip(clip)) {
      const parentId = clip.linkedVideoClipId?.trim();
      if (parentId && !ids.has(parentId)) {
        next = next.map((c) =>
          c.id === parentId ? { ...c, includeAudio: false } : c,
        );
      }
      remove.add(clip.id);
      continue;
    }
    if ((clip.lane ?? "video") === "video" || clip.kind === "video") {
      const companion = findLinkedAudioForVideo(clips, clip.id);
      if (companion) remove.add(companion.id);
    }
  }

  next = next.filter((c) => !remove.has(c.id));
  return syncLinkedVideoAudio(next);
}
