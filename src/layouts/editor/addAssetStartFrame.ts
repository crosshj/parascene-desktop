import { applyImageFraming, extractVideoFrame } from "../../lab/audioTools";
import {
  downloadIds,
  ensureClipThumb,
  ensureReversed,
  getCreations,
} from "../../library/catalogClient";
import { clipTimelineComposition } from "../../library/clipThumbnail";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  creationDetailUrl,
  creationPreviewUrl,
  parascenePublicImageUrl,
} from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import type {
  AddAssetDraft,
  AddAssetFrameSource,
  LyricAlignment,
  TimelineClip,
} from "../../project/types";
import {
  durableFrameSourceFromPreview,
  frameSourceAssetId,
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "../../project/addAssetFrameSource";
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
import { recordUiOpTrace } from "./uiOpTrace";

export type StartFramePreview = {
  previewUrl: string | null;
  note: string;
  framePath: string | null;
  frameTimeSec: number | null;
  framing?: StagedClipFraming;
  /** Project image asset id when the start frame came from the asset picker. */
  sourceAssetId?: string | null;
  /** True when sourceAssetId points at an image (safe to re-use as Assets source). */
  sourceIsImage?: boolean;
  /**
   * Existing Parascene image URL — generation can use this directly instead of
   * uploading a derived still when the asset is already on the cloud.
   */
  remoteImageUrl?: string | null;
};

/** True when a start frame can be sent to generation (local still or cloud URL). */
export function startFrameIsReady(
  preview: StartFramePreview | null | undefined,
): boolean {
  if (!preview) return false;
  if (preview.remoteImageUrl?.trim()) return true;
  return Boolean(preview.framePath?.trim());
}

/** Public Parascene URL for a library image creation, when one exists. */
export function parasceneImageUrlFromCreation(
  creation: Creation | null | undefined,
): string | null {
  if (!creation) return null;
  return parascenePublicImageUrl(creation);
}

/**
 * When framing is fit, return an existing Parascene image URL so generation
 * can reference the asset directly instead of cloning a still.
 */
export async function resolveParasceneStartFrameImageUrl(
  preview: StartFramePreview,
): Promise<string | null> {
  if (normalizeFraming(preview.framing) !== "fit") return null;
  const cached = preview.remoteImageUrl?.trim();
  if (cached) return cached;
  const assetId = preview.sourceAssetId?.trim();
  if (!assetId) return null;
  const [creation] = await getCreations([assetId]);
  return parasceneImageUrlFromCreation(creation);
}

/**
 * Source media time at a timeline instant — same mapping as the program
 * monitor (`clipSourceSec`: trim, speed, loop, ping-pong).
 */
export function clipVisibleSourceSec(
  clip: TimelineClip,
  timelineSec: number,
): number {
  return clipSourceSec(clip, timelineSec);
}

/** Source media time of the last visible frame in a timeline clip. */
export function lastFrameSourceSec(clip: TimelineClip): number {
  // Half-open clip: last shown instant is just before endSec (not file EOF).
  const endTimelineSec = Math.max(clip.startSec, clip.endSec - 0.001);
  return clipSourceSec(clip, endTimelineSec);
}

/** Source media time of the first visible frame in a timeline clip. */
export function firstFrameSourceSec(clip: TimelineClip): number {
  return clipSourceSec(clip, clip.startSec);
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
      // Prefer the composed source time at the cut (loop / ping-pong / speed).
      sourceSec: visual.sourceSec,
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
      sourceSec: visual.sourceSec,
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
      Boolean(clip.assetId?.trim()) &&
      // Video Include Audio companions are not the Master song bed.
      !clip.linkedVideoClipId?.trim(),
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

/** True when a filesystem path looks like a still (not a video). */
export function looksLikeImagePath(path: string | null | undefined): boolean {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return false;
  const base = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "webp" ||
    ext === "gif" ||
    ext === "bmp" ||
    ext === "tif" ||
    ext === "tiff" ||
    ext === "heic" ||
    ext === "avif"
  );
}

function isImagePriorClip(
  clip: TimelineClip,
  creation: Creation | undefined,
): boolean {
  if (clip.kind === "image") return true;
  if (creation?.mediaType === "image") return true;
  // Defense: catalog type can be wrong/missing; extension still routes to framing.
  return looksLikeImagePath(creation?.localPath);
}

/** Basename only — safe for UI diagnostics Copy. */
export function framePathBasename(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.split(/[/\\]/).pop() ?? trimmed;
}

type FrameRole = "start" | "end";

function framingLabel(framing: StagedClipFraming): string {
  return framing === "fill" ? "Fill" : framing === "stretch" ? "Stretch" : "Fit";
}

function timelineFrameNote(role: FrameRole): string {
  return role === "start"
    ? "The start frame matches the previous clip as shown on the timeline."
    : "The end frame matches the next clip as shown on the timeline.";
}

function assetFramingNote(framing: StagedClipFraming): string {
  return `Start frame from project image with ${framingLabel(framing)} framing into the project frame.`;
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

/** Fit/fill/stretch only — used when the composed timeline thumb path fails. */
async function applyNeighborFramingFallback(opts: {
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
      note: timelineFrameNote(opts.role),
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

/**
 * Neighbor start/end frames use the clip’s timeline composition (framing +
 * zoom + center) — the same still the program monitor / timeline thumb shows.
 * Optional generate-form framing is not applied here.
 */
async function resolveFrameFromNeighborClip(opts: {
  neighbor: TimelineClip;
  frameTimeSec: number | null;
  aspectRatio: string;
  role: FrameRole;
  missingLocalNote: string;
  extractFailedNote: string;
}): Promise<StartFramePreview> {
  const { neighbor, aspectRatio, role } = opts;
  const composition = clipTimelineComposition(neighbor, aspectRatio);
  const framing = composition.framing;
  const assetId = neighbor.assetId!.trim();
  let [creation] = await getCreations([assetId]);
  let sourcePath = creation?.localPath?.trim() || null;
  if (!sourcePath && (creation?.remoteUrl?.trim() || creation?.videoUrl?.trim())) {
    // Neighbors often sync thumb-only; pull the media so the frame still resolves.
    recordUiOpTrace({
      type: "add_asset_frame_fetch_media",
      clipId: neighbor.id,
      kind: neighbor.kind ?? creation?.mediaType ?? "?",
      ids: assetId,
      reason: `${role}:download_on_demand`,
    });
    try {
      await downloadIds([assetId]);
      const [fresh] = await getCreations([assetId]);
      if (fresh) creation = fresh;
      sourcePath = creation?.localPath?.trim() || null;
    } catch (downloadError) {
      recordUiOpTrace({
        type: "add_asset_frame_fetch_failed",
        clipId: neighbor.id,
        kind: neighbor.kind ?? creation?.mediaType ?? "?",
        ids: assetId,
        reason: `${role}:${downloadError instanceof Error ? downloadError.message : String(downloadError)}`.slice(
          0,
          180,
        ),
      });
    }
  }
  if (!sourcePath) {
    recordUiOpTrace({
      type: "add_asset_frame_missing_local",
      clipId: neighbor.id,
      kind: neighbor.kind ?? creation?.mediaType ?? "?",
      ids: assetId,
      reason: `${role}:no_local_path`,
    });
    return {
      previewUrl: null,
      note: opts.missingLocalNote,
      framePath: null,
      frameTimeSec: null,
    };
  }

  const fromImage = Boolean(creation && isImagePriorClip(neighbor, creation));
  const frameTimeSec = fromImage
    ? 0
    : (opts.frameTimeSec ??
      (role === "start"
        ? lastFrameSourceSec(neighbor)
        : firstFrameSourceSec(neighbor)));
  const reverse = Boolean(neighbor.reverse);
  const kind = neighbor.kind ?? "video";

  if (!fromImage && reverse && (kind === "video" || kind === "slideshow")) {
    try {
      const reversed = await ensureReversed(assetId);
      if (reversed.path) {
        sourcePath = reversed.path;
      }
    } catch {
      /* fall back to forward source */
    }
  }

  // Prefer the same composed still the timeline uses (includes zoom / pan).
  try {
    const composedPath = await ensureClipThumb(
      assetId,
      reverse,
      frameTimeSec,
      composition,
    );
    const previewUrl = convertFileSrc(composedPath);
    recordUiOpTrace({
      type: "add_asset_frame_resolved",
      clipId: neighbor.id,
      kind: fromImage ? "image" : "video",
      ids: assetId,
      reason: `${role}:timeline_compose path=${framePathBasename(composedPath) || "none"} t=${fromImage ? "—" : frameTimeSec.toFixed(2)} framing=${framing} zoom=${composition.zoom}`,
    });
    return {
      previewUrl,
      note: timelineFrameNote(role),
      framePath: composedPath,
      frameTimeSec: fromImage ? null : frameTimeSec,
      framing,
      sourceAssetId: assetId,
      sourceIsImage: fromImage,
    };
  } catch {
    /* fall through to extract + fit/fill/stretch */
  }

  if (fromImage) {
    const framed = await applyNeighborFramingFallback({
      sourcePath,
      framing,
      aspectRatio,
      fromImage: true,
      role,
      frameTimeSec: null,
      fallbackPreviewUrl:
        creationDetailUrl(creation) ?? creationPreviewUrl(creation),
    });
    recordUiOpTrace({
      type: "add_asset_frame_resolved",
      clipId: neighbor.id,
      kind: "image",
      ids: assetId,
      reason: `${role}:image_fallback path=${framePathBasename(framed.framePath) || "none"} framing=${framed.framing ?? framing}`,
    });
    return { ...framed, sourceAssetId: assetId, sourceIsImage: true };
  }

  let previewUrl: string | null = null;
  let thumbPath: string | null = null;
  try {
    thumbPath = await ensureClipThumb(assetId, reverse, frameTimeSec, composition);
    previewUrl = convertFileSrc(thumbPath);
  } catch {
    try {
      thumbPath = await ensureClipThumb(assetId, reverse, frameTimeSec);
      previewUrl = convertFileSrc(thumbPath);
    } catch {
      thumbPath = null;
      previewUrl = null;
    }
  }

  try {
    const frame = await extractVideoFrame({
      sourcePath,
      timeSec: frameTimeSec,
    });
    const framed = await applyNeighborFramingFallback({
      sourcePath: frame.path,
      framing,
      aspectRatio,
      fromImage: false,
      role,
      frameTimeSec,
      fallbackPreviewUrl: frame.mediaUrl ?? previewUrl,
    });
    recordUiOpTrace({
      type: "add_asset_frame_resolved",
      clipId: neighbor.id,
      kind: "video",
      ids: assetId,
      reason: `${role}:video path=${framePathBasename(framed.framePath) || "none"} t=${frameTimeSec?.toFixed(2) ?? "?"}`,
    });
    return { ...framed, sourceAssetId: assetId, sourceIsImage: false };
  } catch (extractError) {
    // Stills mis-typed as video fail Duration probe; frame as image instead.
    if (
      looksLikeImagePath(sourcePath) ||
      creation?.mediaType === "image" ||
      neighbor.kind === "image"
    ) {
      recordUiOpTrace({
        type: "add_asset_frame_image_fallback",
        clipId: neighbor.id,
        kind: neighbor.kind ?? creation?.mediaType ?? "image",
        ids: assetId,
        reason: `${role}:extract_failed→image ${extractError instanceof Error ? extractError.message : String(extractError)}`.slice(
          0,
          180,
        ),
      });
      const framed = await applyNeighborFramingFallback({
        sourcePath,
        framing,
        aspectRatio,
        fromImage: true,
        role,
        frameTimeSec: null,
        fallbackPreviewUrl: creation
          ? (creationDetailUrl(creation) ??
            creationPreviewUrl(creation) ??
            previewUrl)
          : previewUrl,
      });
      recordUiOpTrace({
        type: "add_asset_frame_resolved",
        clipId: neighbor.id,
        kind: "image_fallback",
        ids: assetId,
        reason: `${role}:image_fallback path=${framePathBasename(framed.framePath) || "none"}`,
      });
      return { ...framed, sourceAssetId: assetId, sourceIsImage: true };
    }
    // Full-res extract failed, but the clip-thumb pipeline already produced a
    // local still at the same source time — use that for generation.
    if (thumbPath?.trim()) {
      recordUiOpTrace({
        type: "add_asset_frame_thumb_fallback",
        clipId: neighbor.id,
        kind: neighbor.kind ?? creation?.mediaType ?? "video",
        ids: assetId,
        reason: `${role}:extract_failed→thumb ${extractError instanceof Error ? extractError.message : String(extractError)}`.slice(
          0,
          180,
        ),
      });
      return {
        previewUrl,
        note: timelineFrameNote(role),
        framePath: thumbPath,
        frameTimeSec,
        framing,
        sourceAssetId: assetId,
        sourceIsImage: false,
      };
    }
    recordUiOpTrace({
      type: "add_asset_frame_extract_fail",
      clipId: neighbor.id,
      kind: neighbor.kind ?? creation?.mediaType ?? "video",
      ids: assetId,
      reason: `${role}:t=${frameTimeSec?.toFixed(2) ?? "?"} ${extractError instanceof Error ? extractError.message : String(extractError)}`.slice(
        0,
        220,
      ),
    });
    const detail =
      extractError instanceof Error ? extractError.message : String(extractError);
    return {
      previewUrl,
      note: `${opts.extractFailedNote} (${detail})`,
      framePath: null,
      frameTimeSec,
      framing,
      sourceAssetId: assetId,
      sourceIsImage: false,
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

/** Use a project image asset as the Parascene Blue / Replicate start frame. */
export async function resolveAddAssetStartFrameFromAsset(
  assetId: string,
  aspectRatio: string = "16:9",
  framing: StagedClipFraming = "fit",
): Promise<StartFramePreview> {
  const id = assetId.trim();
  const resolvedFraming = normalizeFraming(framing);
  if (!id) {
    return {
      previewUrl: null,
      note: "No image asset selected.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  let [creation] = await getCreations([id]);
  const passthroughUrl =
    resolvedFraming === "fit" ? parasceneImageUrlFromCreation(creation) : null;
  let sourcePath = creation?.localPath?.trim() || null;
  if (!sourcePath && creation?.remoteUrl?.trim() && resolvedFraming !== "fit") {
    // Non-fit framing must bake locally — pull the picked image first.
    recordUiOpTrace({
      type: "add_asset_frame_fetch_media",
      clipId: "",
      kind: "image",
      ids: id,
      reason: "start:asset:download_on_demand",
    });
    try {
      await downloadIds([id]);
      const [fresh] = await getCreations([id]);
      if (fresh) creation = fresh;
      sourcePath = creation?.localPath?.trim() || null;
    } catch (downloadError) {
      recordUiOpTrace({
        type: "add_asset_frame_fetch_failed",
        clipId: "",
        kind: "image",
        ids: id,
        reason: `start:asset:${downloadError instanceof Error ? downloadError.message : String(downloadError)}`.slice(
          0,
          180,
        ),
      });
    }
  }
  const previewUrl =
    creationDetailUrl(creation) ?? creationPreviewUrl(creation);
  const remoteImageUrl = creation?.remoteUrl?.trim() || null;

  if (creation?.mediaType !== "image" && sourcePath && !looksLikeImagePath(sourcePath)) {
    return {
      previewUrl,
      note: "Only image assets can be used as a start frame.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  if (!sourcePath) {
    // No local file to bake framing into — last-resort remote URL (unframed).
    // Direct to Blue cannot use remote-only stills; Parascene Creation may.
    if (remoteImageUrl) {
      recordUiOpTrace({
        type: "add_asset_frame_resolved",
        clipId: "",
        kind: "image",
        ids: id,
        reason: "start:asset:remote_url_no_local",
      });
      return {
        previewUrl: previewUrl ?? remoteImageUrl,
        note: "Start frame from project image on Parascene (local file missing — framing not applied).",
        framePath: null,
        frameTimeSec: null,
        framing: resolvedFraming,
        sourceAssetId: id,
        sourceIsImage: true,
        remoteImageUrl,
      };
    }
    recordUiOpTrace({
      type: "add_asset_frame_missing_local",
      clipId: "",
      kind: "image",
      ids: id,
      reason: "start:asset:no_local_path",
    });
    return {
      previewUrl,
      note: "Image asset is not available locally yet — sync or download it first.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  if (creation?.mediaType !== "image" && !looksLikeImagePath(sourcePath)) {
    return {
      previewUrl,
      note: "Only image assets can be used as a start frame.",
      framePath: null,
      frameTimeSec: null,
    };
  }

  // Same JPEG pipeline as timeline neighbor frames (works for Blue/Comfy).
  // Do not fall back to the raw asset file — Blue T2I imports are often PNG,
  // and a silent raw fallback is what made asset picks fail while video frames
  // succeeded.
  const composition = clipTimelineComposition(
    { framing: resolvedFraming, zoom: 1, centerX: 0, centerY: 0 },
    aspectRatio,
  );
  try {
    const composedPath = await ensureClipThumb(id, false, 0, composition);
    recordUiOpTrace({
      type: "add_asset_frame_resolved",
      clipId: "",
      kind: "image",
      ids: id,
      reason: `start:asset:clip_thumb path=${framePathBasename(composedPath) || "none"} framing=${resolvedFraming}`,
    });
    return {
      previewUrl: convertFileSrc(composedPath),
      note: assetFramingNote(resolvedFraming),
      framePath: composedPath,
      frameTimeSec: null,
      framing: resolvedFraming,
      sourceAssetId: id,
      sourceIsImage: true,
      remoteImageUrl: passthroughUrl ?? undefined,
    };
  } catch (thumbError) {
    recordUiOpTrace({
      type: "add_asset_frame_image_fallback",
      clipId: "",
      kind: "image",
      ids: id,
      reason: `start:asset:clip_thumb_failed ${thumbError instanceof Error ? thumbError.message : String(thumbError)}`.slice(
        0,
        180,
      ),
    });
  }

  try {
    const framed = await applyImageFraming({
      sourcePath,
      framing: resolvedFraming,
      aspectRatio,
    });
    recordUiOpTrace({
      type: "add_asset_frame_resolved",
      clipId: "",
      kind: "image",
      ids: id,
      reason: `start:asset:framed path=${framePathBasename(framed.path) || "none"} framing=${resolvedFraming}`,
    });
    return {
      previewUrl: framed.mediaUrl,
      note: assetFramingNote(resolvedFraming),
      framePath: framed.path,
      frameTimeSec: null,
      framing: resolvedFraming,
      sourceAssetId: id,
      sourceIsImage: true,
      remoteImageUrl: passthroughUrl ?? undefined,
    };
  } catch (frameError) {
    recordUiOpTrace({
      type: "add_asset_frame_extract_fail",
      clipId: "",
      kind: "image",
      ids: id,
      reason: `start:asset:frame_failed ${frameError instanceof Error ? frameError.message : String(frameError)}`.slice(
        0,
        220,
      ),
    });
    return {
      previewUrl,
      note: "Could not prepare a JPEG start still from this asset. Re-download it or pick another image.",
      framePath: null,
      frameTimeSec: null,
      framing: resolvedFraming,
      sourceAssetId: id,
      sourceIsImage: true,
    };
  }
}

/** Timeline neighbor first; optional project image asset overrides when set. */
export async function resolveStartFrameForAddAsset(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
  opts?: {
    startFrameAssetId?: string | null;
    framing?: StagedClipFraming;
    firstFrameSource?: AddAssetFrameSource | null;
  },
): Promise<StartFramePreview> {
  const source =
    opts?.firstFrameSource ??
    resolveFirstFrameSource({
      startFrameAssetId: opts?.startFrameAssetId,
    }) ??
    ({ kind: "timeline" } as const);
  return resolveFrameSlot({
    role: "first",
    source,
    timeline,
    placeholder,
    aspectRatio,
    framing: opts?.framing,
  });
}

export async function resolveAddAssetEndFrame(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
): Promise<StartFramePreview> {
  return resolveFrameSlot({
    role: "last",
    source: { kind: "timeline" },
    timeline,
    placeholder,
    aspectRatio,
  });
}

export type BridgeFrames = {
  first: StartFramePreview;
  last: StartFramePreview;
};

export type FrameSlotRole = "first" | "last";

/** Resolve one still slot from an explicit timeline or Assets source. */
export async function resolveFrameSlot(opts: {
  role: FrameSlotRole;
  source: AddAssetFrameSource;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  aspectRatio?: string;
  framing?: StagedClipFraming;
}): Promise<StartFramePreview> {
  const aspectRatio = opts.aspectRatio ?? "16:9";
  const framing = normalizeFraming(opts.framing);
  if (opts.source.kind === "none") {
    return {
      previewUrl: null,
      note: "No frame.",
      framePath: null,
      frameTimeSec: null,
    };
  }
  if (opts.source.kind === "asset") {
    return resolveAddAssetStartFrameFromAsset(
      opts.source.assetId,
      aspectRatio,
      framing,
    );
  }
  if (opts.role === "last") {
    const durationSec = addAssetClipDurationSec(opts.placeholder);
    const placeholderSpan = {
      ...opts.placeholder,
      endSec: opts.placeholder.startSec + durationSec,
    };
    const layer = visualLayerAfterPlaceholder(opts.timeline, placeholderSpan);
    const next =
      layer?.clip ??
      nextVideoClipAfter(
        opts.timeline,
        placeholderSpan.endSec,
        opts.placeholder.id,
      );
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
  return resolveAddAssetStartFrame(
    opts.timeline,
    opts.placeholder,
    aspectRatio,
  );
}

/** Quick check whether a timeline neighbor still is available for the picker. */
export async function peekTimelineFrameSlot(opts: {
  role: FrameSlotRole;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  aspectRatio?: string;
}): Promise<StartFramePreview> {
  return resolveFrameSlot({
    role: opts.role,
    source: { kind: "timeline" },
    timeline: opts.timeline,
    placeholder: opts.placeholder,
    aspectRatio: opts.aspectRatio,
  });
}

/**
 * Resolve first + last from independent sources.
 * Ready when both slots have a usable local path or remote URL.
 */
export async function resolveAddAssetBridgeFramesFromSources(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
  opts?: {
    firstFrameSource?: AddAssetFrameSource | null;
    lastFrameSource?: AddAssetFrameSource | null;
    startFrameAssetId?: string | null;
    framing?: StagedClipFraming;
  },
): Promise<BridgeFrames | null> {
  const firstSource =
    opts?.firstFrameSource ??
    resolveFirstFrameSource({
      startFrameAssetId: opts?.startFrameAssetId,
    }) ??
    ({ kind: "timeline" } as const);
  const lastSource = opts?.lastFrameSource ?? { kind: "timeline" as const };
  const framing = normalizeFraming(opts?.framing);
  const [first, last] = await Promise.all([
    resolveFrameSlot({
      role: "first",
      source: firstSource,
      timeline,
      placeholder,
      aspectRatio,
      framing: firstSource.kind === "asset" ? framing : undefined,
    }),
    resolveFrameSlot({
      role: "last",
      source: lastSource,
      timeline,
      placeholder,
      aspectRatio,
      framing: lastSource.kind === "asset" ? framing : undefined,
    }),
  ]);
  if (!startFrameIsReady(first) || !startFrameIsReady(last)) return null;
  return { first, last };
}

/**
 * First = last frame of prior clip; last = first frame of next clip.
 * Returns null unless both frames have a usable local path.
 * @deprecated Prefer {@link resolveAddAssetBridgeFramesFromSources}.
 */
export async function resolveAddAssetBridgeFrames(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  aspectRatio: string = "16:9",
): Promise<BridgeFrames | null> {
  return resolveAddAssetBridgeFramesFromSources(
    timeline,
    placeholder,
    aspectRatio,
    {
      firstFrameSource: { kind: "timeline" },
      lastFrameSource: { kind: "timeline" },
    },
  );
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

/**
 * Re-resolve first/last stills against the original generated clip's timeline
 * position and stamp preview URLs + durable image sources onto a Generate-new
 * draft. Timeline-only sources on a new end-of-timeline placeholder otherwise
 * show “No previous/next clip.”
 */
export async function enrichDraftFramesFromTimelineAnchor(opts: {
  draft: AddAssetDraft;
  timeline: readonly TimelineClip[];
  anchor: TimelineClip;
  aspectRatio?: string;
}): Promise<AddAssetDraft> {
  const draft = { ...opts.draft };
  const aspectRatio = opts.aspectRatio ?? "16:9";
  const firstSource =
    resolveFirstFrameSource({
      firstFrameSource: draft.firstFrameSource,
      startFrameAssetId: draft.startFrameAssetId,
    }) ??
    (draft.continuityMode === "none"
      ? ({ kind: "none" } as const)
      : ({ kind: "timeline" } as const));
  const lastSource = resolveLastFrameSource({
    lastFrameSource: draft.lastFrameSource,
    continuityMode: draft.continuityMode,
  });

  const needsFirst =
    firstSource.kind !== "none" &&
    (!draft.startFramePreviewUrl?.trim() || firstSource.kind === "timeline");
  const needsLast =
    lastSource.kind !== "none" &&
    (!draft.endFramePreviewUrl?.trim() || lastSource.kind === "timeline");
  if (!needsFirst && !needsLast) {
    return draft;
  }

  const [first, last] = await Promise.all([
    resolveFrameSlot({
      role: "first",
      source: firstSource,
      timeline: opts.timeline,
      placeholder: opts.anchor,
      aspectRatio,
    }),
    resolveFrameSlot({
      role: "last",
      source: lastSource,
      timeline: opts.timeline,
      placeholder: opts.anchor,
      aspectRatio,
    }),
  ]);

  const firstPreview = first.previewUrl?.trim() || null;
  const lastPreview = last.previewUrl?.trim() || null;
  if (firstPreview && !draft.startFramePreviewUrl?.trim()) {
    draft.startFramePreviewUrl = firstPreview;
  }
  if (lastPreview && !draft.endFramePreviewUrl?.trim()) {
    draft.endFramePreviewUrl = lastPreview;
  }

  const durableFirst = durableFrameSourceFromPreview(first, firstSource);
  const durableLast = durableFrameSourceFromPreview(last, lastSource);
  if (durableFirst) {
    draft.firstFrameSource = durableFirst;
    const assetId = frameSourceAssetId(durableFirst);
    if (assetId) draft.startFrameAssetId = assetId;
  }
  if (durableLast) {
    draft.lastFrameSource = durableLast;
  }
  return draft;
}
