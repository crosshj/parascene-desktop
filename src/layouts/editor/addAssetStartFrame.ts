import { extractVideoFrame } from "../../lab/audioTools";
import { getCreations, ensureReversed } from "../../library/catalogClient";
import { ensureClipThumbnail } from "../../library/clipThumbnail";
import {
  creationDetailUrl,
  creationPreviewUrl,
} from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import type { LyricAlignment, TimelineClip } from "../../project/types";
import {
  clipInSec,
  clipSourceSec,
  resolveTimelineFrame,
} from "./timelineCompose";
import { ADD_ASSET_TIMELINE_DURATION_SEC } from "./stagedClip";

export type StartFramePreview = {
  previewUrl: string | null;
  note: string;
  framePath: string | null;
  frameTimeSec: number | null;
};

/** Source media time within the visible timeline span of a clip. */
export function clipVisibleSourceSec(
  clip: TimelineClip,
  timelineSec: number,
): number {
  const inSec = clipInSec(clip);
  const visibleDur = Math.max(0.1, clip.endSec - clip.startSec);
  const local = Math.max(
    0,
    Math.min(timelineSec - clip.startSec, visibleDur),
  );
  return inSec + local;
}

/** Source media time of the last visible frame in a timeline clip. */
export function lastFrameSourceSec(clip: TimelineClip): number {
  const endTimelineSec = Math.max(clip.startSec, clip.endSec - 0.05);
  return clipVisibleSourceSec(clip, endTimelineSec);
}

function isVisualTimelineClip(clip: TimelineClip): boolean {
  if (clip.isAddAssetPlaceholder) return false;
  if (clip.lane === "audio" || clip.kind === "audio") return false;
  return Boolean(clip.assetId?.trim());
}

/**
 * Visual layer on the timeline immediately before a placeholder cut.
 * Uses the same composition rules as the program monitor.
 */
export function visualLayerBeforePlaceholder(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): { clip: TimelineClip; sourceSec: number } | null {
  const cutSec = placeholder.startSec;
  for (const epsilon of [0.001, 0.01, 0.05, 0.1]) {
    const t = Math.max(0, cutSec - epsilon);
    const { visual } = resolveTimelineFrame(timeline, t);
    if (!visual?.clip.assetId?.trim()) continue;
    if (visual.clip.isAddAssetPlaceholder) continue;
    if (visual.clip.id === placeholder.id) continue;
    return {
      clip: visual.clip,
      sourceSec: lastFrameSourceSec(visual.clip),
    };
  }
  return null;
}

/**
 * Video clip on V1 immediately before `beforeSec` (smallest gap, then latest end).
 */
export function priorVideoClipBefore(
  timeline: readonly TimelineClip[],
  beforeSec: number,
  excludeClipId?: string,
): TimelineClip | null {
  let best: TimelineClip | null = null;
  let bestGap = Infinity;
  let bestEnd = -Infinity;

  for (const clip of timeline) {
    if (excludeClipId && clip.id === excludeClipId) continue;
    if (!isVisualTimelineClip(clip)) continue;
    if (clip.endSec > beforeSec + 0.001) continue;

    const gap = beforeSec - clip.endSec;
    const endSec = clip.endSec;
    if (
      gap < bestGap - 0.0001 ||
      (Math.abs(gap - bestGap) < 0.0001 && endSec > bestEnd + 0.0001)
    ) {
      bestGap = gap;
      bestEnd = endSec;
      best = clip;
    }
  }

  return best;
}

export function resolveAlignmentAudioClip(
  timeline: readonly TimelineClip[],
  alignment: LyricAlignment | null | undefined,
  mainAudioCreationId: string | null,
): TimelineClip | null {
  const audioClips = timeline.filter(
    (clip) =>
      (clip.lane === "audio" || clip.kind === "audio") &&
      Boolean(clip.assetId?.trim()),
  );
  const alignId = alignment?.sourceAudioCreationId?.trim();
  if (alignId) {
    const aligned = audioClips.find((clip) => clip.assetId === alignId);
    if (aligned) return aligned;
  }
  return resolveMainAudioClip(timeline, mainAudioCreationId);
}

export function resolveMainAudioClip(
  timeline: readonly TimelineClip[],
  mainAudioCreationId: string | null,
): TimelineClip | null {
  const audioClips = timeline.filter(
    (clip) =>
      (clip.lane === "audio" || clip.kind === "audio") &&
      Boolean(clip.assetId?.trim()),
  );
  const mainId = mainAudioCreationId?.trim();
  if (mainId) {
    return audioClips.find((clip) => clip.assetId === mainId) ?? audioClips[0] ?? null;
  }
  return audioClips[0] ?? null;
}

/** Map a timeline second to song/source-audio seconds via the aligned audio clip. */
export function timelineSecToSongSec(
  timeline: readonly TimelineClip[],
  timelineSec: number,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): number {
  const audio = resolveAlignmentAudioClip(
    timeline,
    alignment,
    mainAudioCreationId,
  );
  if (!audio) return timelineSec;
  if (audio.startSec === 0 && clipInSec(audio) === 0) return timelineSec;
  return clipSourceSec(audio, timelineSec);
}

function isImagePriorClip(
  clip: TimelineClip,
  creation: Creation | undefined,
): boolean {
  if (clip.kind === "image") return true;
  return creation?.mediaType === "image";
}

function imageStartFramePreview(
  creation: Creation,
  sourcePath: string,
): StartFramePreview {
  return {
    previewUrl:
      creationDetailUrl(creation) ?? creationPreviewUrl(creation),
    note: "The start frame is the image from the previous clip.",
    framePath: sourcePath,
    frameTimeSec: null,
  };
}

export async function resolveAddAssetStartFrame(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): Promise<StartFramePreview> {
  const layer = visualLayerBeforePlaceholder(timeline, placeholder);
  const prior = layer?.clip ?? priorVideoClipBefore(
    timeline,
    placeholder.startSec,
    placeholder.id,
  );
  if (!prior) {
    return {
      previewUrl: null,
      note: "No previous clip on the timeline.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  const assetId = prior.assetId!.trim();
  const [creation] = await getCreations([assetId]);
  let sourcePath = creation?.localPath?.trim() || null;
  if (!sourcePath) {
    return {
      previewUrl: null,
      note: "Previous clip is not available locally yet.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  if (creation && isImagePriorClip(prior, creation)) {
    return imageStartFramePreview(creation, sourcePath);
  }

  const frameTimeSec =
    layer?.sourceSec ?? lastFrameSourceSec(prior);
  const reverse = Boolean(prior.reverse);
  const kind = prior.kind ?? "video";

  if (reverse && (kind === "video" || kind === "slideshow")) {
    try {
      const reversed = await ensureReversed(assetId);
      if (reversed.path) {
        sourcePath = reversed.path;
      }
    } catch {
      /* fall back to forward source */
    }
  }

  let previewUrl: string | null = null;
  try {
    previewUrl = await ensureClipThumbnail(assetId, reverse, frameTimeSec);
  } catch {
    previewUrl = null;
  }

  try {
    const frame = await extractVideoFrame({
      sourcePath,
      timeSec: frameTimeSec,
    });
    return {
      previewUrl: frame.mediaUrl ?? previewUrl,
      note: "The start frame is the last frame of the previous video clip.",
      framePath: frame.path,
      frameTimeSec,
    };
  } catch {
    return {
      previewUrl,
      note: previewUrl
        ? "The start frame is the last frame of the previous video clip."
        : "Could not extract the last frame from the previous clip.",
      framePath: null,
      frameTimeSec: previewUrl ? frameTimeSec : null,
    };
  }
}

export function clipSongTimeRangeFromTimeline(
  timeline: readonly TimelineClip[],
  clip: TimelineClip,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): { startSec: number; endSec: number } {
  const timelineStart = clip.startSec;
  const timelineEnd = clip.startSec + ADD_ASSET_TIMELINE_DURATION_SEC;
  return {
    startSec: timelineSecToSongSec(
      timeline,
      timelineStart,
      mainAudioCreationId,
      alignment,
    ),
    endSec: timelineSecToSongSec(
      timeline,
      Math.max(timelineStart, timelineEnd - 0.001),
      mainAudioCreationId,
      alignment,
    ),
  };
}
