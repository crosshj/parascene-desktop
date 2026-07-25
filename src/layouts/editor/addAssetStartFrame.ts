import { applyImageFraming, extractVideoFrame } from "../../lab/audioTools";
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
import {
  addAssetClipDurationSec,
  normalizeFraming,
  type StagedClipFraming,
} from "./stagedClip";

export type StartFramePreview = {
  previewUrl: string | null;
  note: string;
  framePath: string | null;
  frameTimeSec: number | null;
  framing?: StagedClipFraming;
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

/** Source media time of the first visible frame in a timeline clip. */
export function firstFrameSourceSec(clip: TimelineClip): number {
  return clipVisibleSourceSec(clip, clip.startSec);
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
 * Visual layer on the timeline immediately after a placeholder ends.
 * Uses the same composition rules as the program monitor.
 */
export function visualLayerAfterPlaceholder(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): { clip: TimelineClip; sourceSec: number } | null {
  const cutSec = placeholder.endSec;
  for (const epsilon of [0.001, 0.01, 0.05, 0.1]) {
    const t = cutSec + epsilon;
    const { visual } = resolveTimelineFrame(timeline, t);
    if (!visual?.clip.assetId?.trim()) continue;
    if (visual.clip.isAddAssetPlaceholder) continue;
    if (visual.clip.id === placeholder.id) continue;
    return {
      clip: visual.clip,
      sourceSec: firstFrameSourceSec(visual.clip),
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

/**
 * Video clip on V1 immediately after `afterSec` (smallest gap, then earliest start).
 */
export function nextVideoClipAfter(
  timeline: readonly TimelineClip[],
  afterSec: number,
  excludeClipId?: string,
): TimelineClip | null {
  let best: TimelineClip | null = null;
  let bestGap = Infinity;
  let bestStart = Infinity;

  for (const clip of timeline) {
    if (excludeClipId && clip.id === excludeClipId) continue;
    if (!isVisualTimelineClip(clip)) continue;
    if (clip.startSec < afterSec - 0.001) continue;

    const gap = clip.startSec - afterSec;
    const startSec = clip.startSec;
    if (
      gap < bestGap - 0.0001 ||
      (Math.abs(gap - bestGap) < 0.0001 && startSec < bestStart - 0.0001)
    ) {
      bestGap = gap;
      bestStart = startSec;
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

/**
 * Creation id for editor generate / lyrics: prefer the audio clip on the
 * timeline, then Lab/project main audio, then any project audio asset.
 */
export function resolveEditorMainAudioCreationId(
  timeline: readonly TimelineClip[],
  projectMainAudioCreationId: string | null | undefined,
  projectAudioAssetId?: string | null,
): string | null {
  const preferred =
    projectMainAudioCreationId?.trim() ||
    projectAudioAssetId?.trim() ||
    null;
  const fromTimeline = resolveMainAudioClip(timeline, preferred)?.assetId?.trim();
  if (fromTimeline) return fromTimeline;
  return preferred;
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

type FrameRole = "start" | "end";

function framingNote(
  framing: StagedClipFraming,
  fromImage: boolean,
  role: FrameRole,
): string {
  const neighbor = role === "start" ? "previous" : "next";
  const source =
    fromImage ? "image" : role === "start" ? "last frame" : "first frame";
  const label =
    framing === "fill" ? "Fill" : framing === "stretch" ? "Stretch" : "Fit";
  const which = role === "start" ? "start" : "end";
  return `The ${which} frame is the ${neighbor} clip’s ${source} with ${label} framing.`;
}

function framingFallbackNote(
  fromImage: boolean,
  role: FrameRole,
): string {
  if (role === "start") {
    return fromImage
      ? "The start frame is the image from the previous clip."
      : "The start frame is the last frame of the previous video clip.";
  }
  return fromImage
    ? "The end frame is the image from the next clip."
    : "The end frame is the first frame of the next video clip.";
}

async function applyNeighborFraming(opts: {
  sourcePath: string;
  framing: StagedClipFraming;
  aspectRatio: string;
  fromImage: boolean;
  role: FrameRole;
  frameTimeSec: number | null;
  fallbackPreviewUrl?: string | null;
}): Promise<StartFramePreview> {
  try {
    const framed = await applyImageFraming({
      sourcePath: opts.sourcePath,
      framing: opts.framing,
      aspectRatio: opts.aspectRatio,
    });
    return {
      previewUrl: framed.mediaUrl,
      note: framingNote(opts.framing, opts.fromImage, opts.role),
      framePath: framed.path,
      frameTimeSec: opts.frameTimeSec,
      framing: opts.framing,
    };
  } catch {
    return {
      previewUrl: opts.fallbackPreviewUrl ?? null,
      note: framingFallbackNote(opts.fromImage, opts.role),
      framePath: opts.sourcePath,
      frameTimeSec: opts.frameTimeSec,
      framing: opts.framing,
    };
  }
}

async function resolveFrameFromNeighborClip(opts: {
  neighbor: TimelineClip;
  frameTimeSec: number | null;
  aspectRatio: string;
  role: FrameRole;
  missingLocalNote: string;
  extractFailedNote: string;
}): Promise<StartFramePreview> {
  const { neighbor, aspectRatio, role } = opts;
  const framing = normalizeFraming(neighbor.framing);
  const assetId = neighbor.assetId!.trim();
  const [creation] = await getCreations([assetId]);
  let sourcePath = creation?.localPath?.trim() || null;
  if (!sourcePath) {
    return {
      previewUrl: null,
      note: opts.missingLocalNote,
      framePath: null,
      frameTimeSec: null,
    };
  }

  if (creation && isImagePriorClip(neighbor, creation)) {
    return applyNeighborFraming({
      sourcePath,
      framing,
      aspectRatio,
      fromImage: true,
      role,
      frameTimeSec: null,
      fallbackPreviewUrl:
        creationDetailUrl(creation) ?? creationPreviewUrl(creation),
    });
  }

  const frameTimeSec =
    opts.frameTimeSec ??
    (role === "start"
      ? lastFrameSourceSec(neighbor)
      : firstFrameSourceSec(neighbor));
  const reverse = Boolean(neighbor.reverse);
  const kind = neighbor.kind ?? "video";

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
    return applyNeighborFraming({
      sourcePath: frame.path,
      framing,
      aspectRatio,
      fromImage: false,
      role,
      frameTimeSec,
      fallbackPreviewUrl: frame.mediaUrl ?? previewUrl,
    });
  } catch {
    return {
      previewUrl,
      note: previewUrl
        ? framingFallbackNote(false, role)
        : opts.extractFailedNote,
      framePath: null,
      frameTimeSec: previewUrl ? frameTimeSec : null,
      framing,
    };
  }
}

export async function resolveAddAssetStartFrame(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
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

  return resolveFrameFromNeighborClip({
    neighbor: prior,
    frameTimeSec: layer?.sourceSec ?? null,
    aspectRatio,
    role: "start",
    missingLocalNote: "Previous clip is not available locally yet.",
    extractFailedNote: "Could not extract the last frame from the previous clip.",
  });
}

export async function resolveAddAssetEndFrame(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
): Promise<StartFramePreview> {
  const durationSec = addAssetClipDurationSec(placeholder);
  const placeholderSpan = {
    ...placeholder,
    endSec: placeholder.startSec + durationSec,
  };
  const layer = visualLayerAfterPlaceholder(timeline, placeholderSpan);
  const next =
    layer?.clip ??
    nextVideoClipAfter(timeline, placeholderSpan.endSec, placeholder.id);
  if (!next) {
    return {
      previewUrl: null,
      note: "No next clip on the timeline.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  return resolveFrameFromNeighborClip({
    neighbor: next,
    frameTimeSec: layer?.sourceSec ?? null,
    aspectRatio,
    role: "end",
    missingLocalNote: "Next clip is not available locally yet.",
    extractFailedNote: "Could not extract the first frame from the next clip.",
  });
}

export type BridgeFrames = {
  first: StartFramePreview;
  last: StartFramePreview;
};

/**
 * First = last frame of prior clip; last = first frame of next clip.
 * Returns null unless both frames have a usable local path.
 */
export async function resolveAddAssetBridgeFrames(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
): Promise<BridgeFrames | null> {
  const [first, last] = await Promise.all([
    resolveAddAssetStartFrame(timeline, placeholder, aspectRatio),
    resolveAddAssetEndFrame(timeline, placeholder, aspectRatio),
  ]);
  if (!first.framePath?.trim() || !last.framePath?.trim()) return null;
  return { first, last };
}

export function clipSongTimeRangeFromTimeline(
  timeline: readonly TimelineClip[],
  clip: TimelineClip,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): { startSec: number; endSec: number } {
  const timelineStart = clip.startSec;
  // Always use the clamped add-asset window so lyrics / audio / API agree.
  const durationSec = addAssetClipDurationSec(clip);
  const timelineEnd = clip.startSec + durationSec;
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

/**
 * Single timing source for generate: clamped duration + matching song window.
 * Audio slice length and `duration_seconds` must both use `durationSec`.
 */
export function resolveAddAssetGenerationTiming(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): {
  durationSec: number;
  songRange: { startSec: number; endSec: number };
} {
  const durationSec = addAssetClipDurationSec(placeholder);
  const songRange = clipSongTimeRangeFromTimeline(
    timeline,
    { ...placeholder, endSec: placeholder.startSec + durationSec },
    mainAudioCreationId,
    alignment,
  );
  return { durationSec, songRange };
}
