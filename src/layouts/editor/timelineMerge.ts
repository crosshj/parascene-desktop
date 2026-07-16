import type { TimelineClip } from "../../project/types";

export const MERGE_CONTIGUITY_EPSILON_SEC = 0.05;

export type MergeableTimelineSelection = {
  clips: TimelineClip[];
  startSec: number;
  endSec: number;
};

function compareTimelineClips(a: TimelineClip, b: TimelineClip): number {
  return a.startSec - b.startSec || a.endSec - b.endSec || a.id.localeCompare(b.id);
}

function isVideoLaneClip(clip: TimelineClip): boolean {
  return (clip.lane ?? "video") === "video";
}

function isMergeableVideoClip(clip: TimelineClip): boolean {
  return isVideoLaneClip(clip) && clip.kind === "video" && Boolean(clip.assetId);
}

export function getMergeableTimelineSelection(
  timeline: TimelineClip[],
  selectedClipIds: readonly string[],
): MergeableTimelineSelection | null {
  if (selectedClipIds.length < 2) return null;
  const selectedIdSet = new Set(selectedClipIds);
  const clips = timeline
    .filter((clip) => selectedIdSet.has(clip.id))
    .sort(compareTimelineClips);
  if (clips.length < 2) return null;
  if (!clips.every(isMergeableVideoClip)) return null;

  for (let i = 1; i < clips.length; i += 1) {
    const prev = clips[i - 1];
    const next = clips[i];
    if (!prev || !next) return null;
    if (Math.abs(prev.endSec - next.startSec) > MERGE_CONTIGUITY_EPSILON_SEC) {
      return null;
    }
  }

  const first = clips[0];
  const last = clips[clips.length - 1];
  if (!first || !last) return null;
  return {
    clips,
    startSec: first.startSec,
    endSec: last.endSec,
  };
}
