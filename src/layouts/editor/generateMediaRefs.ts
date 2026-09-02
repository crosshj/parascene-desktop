/**
 * Typed Generate refs for Video to Video and Refs to Video.
 * Blue/Parascene take typed slots — not one mixed bag.
 */

import type { TimelineClip } from "../../project/types";
import type { GenerateIntentId } from "./previewIntent";
import { visualLayerBeforePlaceholder } from "./addAssetStartFrame";

export type TimelineAudioMode = "none" | "full_mix" | "vocals";

export type GenerateMediaRefs = {
  /** Driving / source video (Video to Video). */
  inputVideoAssetId: string | null;
  /** Optional character / start still for v2v models that need one. */
  characterImageAssetId: string | null;
  referenceImageAssetIds: string[];
  referenceVideoAssetIds: string[];
  referenceAudioAssetIds: string[];
  /** Clip this placeholder’s window from the timeline mix (A2V-style). */
  timelineAudio: TimelineAudioMode;
  /** Source window into the driving video (seconds). */
  startOffsetSeconds: number;
};

export const EMPTY_GENERATE_MEDIA_REFS: GenerateMediaRefs = {
  inputVideoAssetId: null,
  characterImageAssetId: null,
  referenceImageAssetIds: [],
  referenceVideoAssetIds: [],
  referenceAudioAssetIds: [],
  timelineAudio: "none",
  startOffsetSeconds: 0,
};

export const V2V_MODELS_NEEDING_CHARACTER = new Set([
  "ltx_ic_lora",
  "wan_animate",
  "wan_scail",
  "wan_scail_fp16",
  "wan_motion",
]);

export const H3_R2V_MODEL_ID = "minimax_r2v";
export const DEFAULT_V2V_MODEL_ID = "bernini_r_v2v";
export const DEFAULT_R2V_MODEL_ID = H3_R2V_MODEL_ID;

export const H3_R2V_LIMITS = {
  maxImages: 9,
  maxVideos: 3,
  maxAudios: 3,
} as const;

/** Previous-clip still (I2V first-frame neighbor). */
export const TIMELINE_IMAGE_PREVIOUS = "__timeline_previous__";
/** Next-clip still (I2V last-frame neighbor). */
export const TIMELINE_IMAGE_NEXT = "__timeline_next__";

export function isTimelineImageRefId(id: string | null | undefined): boolean {
  const value = id?.trim() ?? "";
  return value === TIMELINE_IMAGE_PREVIOUS || value === TIMELINE_IMAGE_NEXT;
}

export function timelineImageRefRole(
  id: string,
): "first" | "last" | null {
  const value = id.trim();
  if (value === TIMELINE_IMAGE_PREVIOUS) return "first";
  if (value === TIMELINE_IMAGE_NEXT) return "last";
  return null;
}

export function timelineImageRefLabel(id: string): string | null {
  const value = id.trim();
  if (value === TIMELINE_IMAGE_PREVIOUS) return "Previous clip";
  if (value === TIMELINE_IMAGE_NEXT) return "Next clip";
  return null;
}

export function isAdvancedVideoIntent(
  intentId: GenerateIntentId | null | undefined,
): intentId is "video_to_video" | "reference_to_video" {
  return intentId === "video_to_video" || intentId === "reference_to_video";
}

export function normalizeGenerateMediaRefs(
  raw: Partial<GenerateMediaRefs> | null | undefined,
): GenerateMediaRefs {
  const ids = (list: unknown): string[] =>
    Array.isArray(list)
      ? [
          ...new Set(
            list
              .map((id) => (typeof id === "string" ? id.trim() : ""))
              .filter((id) => Boolean(id)),
          ),
        ]
      : [];
  const offset = Number(raw?.startOffsetSeconds);
  const timelineAudio: TimelineAudioMode =
    raw?.timelineAudio === "full_mix" || raw?.timelineAudio === "vocals"
      ? raw.timelineAudio
      : "none";
  const extraAudios = ids(raw?.referenceAudioAssetIds);
  const timelineSlots = timelineAudio === "none" ? 0 : 1;
  return {
    inputVideoAssetId: raw?.inputVideoAssetId?.trim() || null,
    characterImageAssetId: raw?.characterImageAssetId?.trim() || null,
    referenceImageAssetIds: ids(raw?.referenceImageAssetIds),
    referenceVideoAssetIds: ids(raw?.referenceVideoAssetIds),
    referenceAudioAssetIds: extraAudios.slice(
      0,
      Math.max(0, H3_R2V_LIMITS.maxAudios - timelineSlots),
    ),
    timelineAudio,
    startOffsetSeconds:
      Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}

export function timelineAudioSlotCount(refs: GenerateMediaRefs): 0 | 1 {
  return refs.timelineAudio === "none" ? 0 : 1;
}

export function extraAudioSlotsRemaining(refs: GenerateMediaRefs): number {
  return Math.max(
    0,
    H3_R2V_LIMITS.maxAudios -
      timelineAudioSlotCount(refs) -
      refs.referenceAudioAssetIds.length,
  );
}

export function previousTimelineVideoAssetId(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): string | null {
  const prev = visualLayerBeforePlaceholder(timeline, placeholder);
  const clip = prev?.clip;
  if (!clip?.assetId?.trim()) return null;
  if (clip.kind === "audio" || clip.kind === "image") return null;
  return clip.assetId.trim();
}

export function v2vModelNeedsCharacter(modelId: string | null | undefined): boolean {
  return V2V_MODELS_NEEDING_CHARACTER.has((modelId ?? "").trim());
}

export function validateGenerateMediaRefs(opts: {
  intentId: GenerateIntentId;
  refs: GenerateMediaRefs;
  modelId?: string | null;
}): string | null {
  const refs = normalizeGenerateMediaRefs(opts.refs);
  if (opts.intentId === "video_to_video") {
    if (!refs.inputVideoAssetId) {
      return "Choose a source video (timeline neighbor or Assets video).";
    }
    if (v2vModelNeedsCharacter(opts.modelId) && !refs.characterImageAssetId) {
      return "This model needs a character or start image.";
    }
    return null;
  }
  if (opts.intentId === "reference_to_video") {
    const images = refs.referenceImageAssetIds.length;
    const videos = refs.referenceVideoAssetIds.length;
    const audios =
      timelineAudioSlotCount(refs) + refs.referenceAudioAssetIds.length;
    if (images === 0 && videos === 0) {
      return "Add at least one reference image or video.";
    }
    if (images > H3_R2V_LIMITS.maxImages) {
      return `At most ${H3_R2V_LIMITS.maxImages} reference images.`;
    }
    if (videos > H3_R2V_LIMITS.maxVideos) {
      return `At most ${H3_R2V_LIMITS.maxVideos} reference videos.`;
    }
    if (audios > H3_R2V_LIMITS.maxAudios) {
      return `At most ${H3_R2V_LIMITS.maxAudios} reference audio clips.`;
    }
    return null;
  }
  return null;
}

/** Prompt tag hint by attachment order (MiniMax H3). */
export function referencePromptTagHint(refs: GenerateMediaRefs): string {
  const n = normalizeGenerateMediaRefs(refs);
  const tags: string[] = [];
  n.referenceImageAssetIds.forEach((_, i) => tags.push(`<Picture ${i + 1}>`));
  n.referenceVideoAssetIds.forEach((_, i) => tags.push(`<Video ${i + 1}>`));
  let audioIndex = 0;
  if (n.timelineAudio !== "none") {
    audioIndex += 1;
    tags.push(`<Audio ${audioIndex}>`);
  }
  n.referenceAudioAssetIds.forEach(() => {
    audioIndex += 1;
    tags.push(`<Audio ${audioIndex}>`);
  });
  return tags.join(" ");
}
