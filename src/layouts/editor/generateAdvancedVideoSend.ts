/**
 * Pure send plan for Video to Video / Refs to Video.
 * Runners resolve slot ids to Creation URLs (Parascene) or local files (Blue).
 * Replicate stays unwired until minimax/h3 is in the Lab catalog.
 */

import {
  normalizeGenerateMediaRefs,
  type GenerateMediaRefs,
} from "./generateMediaRefs";
import type { GenerateIntentId } from "./previewIntent";

export type AdvancedVideoLane = "parascene" | "blue_direct" | "replicate";

export type AdvancedVideoSlotIds = {
  images: string[];
  videos: string[];
  audios: string[];
};

/** Live Replicate minimax/h3 OpenAPI input names (public model page, 2026-09-02). */
export const REPLICATE_H3_INPUT_NAMES = [
  "prompt",
  "first_frame_image",
  "last_frame_image",
  "reference_image_urls",
  "reference_video_urls",
  "reference_audio_urls",
  "duration",
  "resolution",
  "ratio",
] as const;

export type AdvancedVideoSendPlan = {
  method: "video2video" | "reference2video";
  transport: "creation_urls" | "local_files" | "unwired";
  /** Field names the runner fills after resolving each slot id. */
  mediaFields: {
    images: "input_images" | "reference_image_urls";
    videos: "input_video_urls" | "reference_video_urls";
    audios: "input_audio_urls" | "reference_audio_urls";
  };
  slotIds: AdvancedVideoSlotIds;
  args: Record<string, unknown>;
};

export function advancedVideoMethod(
  intentId: Extract<GenerateIntentId, "video_to_video" | "reference_to_video">,
): "video2video" | "reference2video" {
  return intentId === "video_to_video" ? "video2video" : "reference2video";
}

export function advancedVideoSlotIds(
  intentId: Extract<GenerateIntentId, "video_to_video" | "reference_to_video">,
  refs: GenerateMediaRefs,
): AdvancedVideoSlotIds {
  const n = normalizeGenerateMediaRefs(refs);
  if (intentId === "video_to_video") {
    return {
      images: n.characterImageAssetId ? [n.characterImageAssetId] : [],
      videos: n.inputVideoAssetId ? [n.inputVideoAssetId] : [],
      audios: [],
    };
  }
  return {
    images: n.referenceImageAssetIds,
    videos: n.referenceVideoAssetIds,
    audios: n.referenceAudioAssetIds,
  };
}

export function planAdvancedVideoSend(opts: {
  intentId: Extract<GenerateIntentId, "video_to_video" | "reference_to_video">;
  lane: AdvancedVideoLane;
  prompt: string;
  model: string;
  aspectRatio: string;
  durationSec?: number;
  refs: GenerateMediaRefs;
}): AdvancedVideoSendPlan {
  const refs = normalizeGenerateMediaRefs(opts.refs);
  const method = advancedVideoMethod(opts.intentId);
  const slotIds = advancedVideoSlotIds(opts.intentId, refs);
  const args: Record<string, unknown> = {
    prompt: opts.prompt.trim(),
    model: opts.model.trim(),
    aspect_ratio: opts.aspectRatio,
  };
  if (opts.durationSec && opts.durationSec > 0) {
    args.duration_seconds = opts.durationSec;
  }
  if (opts.intentId === "video_to_video" && refs.startOffsetSeconds > 0) {
    args.start_offset_seconds = refs.startOffsetSeconds;
  }

  if (opts.lane === "replicate") {
    return {
      method,
      transport: "unwired",
      mediaFields: {
        images: "reference_image_urls",
        videos: "reference_video_urls",
        audios: "reference_audio_urls",
      },
      slotIds,
      args: {
        prompt: opts.prompt.trim(),
        duration: opts.durationSec,
      },
    };
  }

  return {
    method,
    transport: opts.lane === "parascene" ? "creation_urls" : "local_files",
    mediaFields: {
      images: "input_images",
      videos: "input_video_urls",
      audios: "input_audio_urls",
    },
    slotIds,
    args,
  };
}
