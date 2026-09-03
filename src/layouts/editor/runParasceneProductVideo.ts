/**
 * Parascene credits path — video2video / reference2video via server 6.
 */

import { getCreations } from "../../library/catalogClient";
import type { Creation } from "../../library/types";
import { parascenePublicImageUrl } from "../../library/previewUrl";
import { uploadLocalImageFile } from "../../lab/audioTools";
import {
  invokeParasceneGenerate,
  pendingCreationIdFromRun,
  watchParasceneGenerate,
} from "../../services/generateStill";
import type { ServiceRun } from "../../services/types";
import type { GenerateIntentId } from "./previewIntent";
import {
  parasceneMethodForIntent,
  parasceneServerIdForIntent,
} from "./parasceneProductCaps";
import {
  resolveAddAssetGenerationTiming,
  resolveParasceneStartFrameImageUrl,
  type StartFramePreview,
} from "./addAssetStartFrame";
import type { LyricAlignment } from "../../project/types";
import type { TimelineClip } from "../../project/types";
import {
  isTimelineImageRefId,
  normalizeGenerateMediaRefs,
  validateGenerateMediaRefs,
  type GenerateMediaRefs,
} from "./generateMediaRefs";
import { planAdvancedVideoSend } from "./generateAdvancedVideoSend";
import {
  attachParasceneTimelineAudioToCreateArgs,
  attachParasceneAudioClipId,
  isGenericPromptAudioUrl,
  resolveParasceneAudioAssetForCreate,
} from "./timelineReferenceAudio";
import { resolveReferenceImageStill } from "./timelineReferenceImages";
import { resolveParasceneVideoRefUrl } from "./parasceneCreationMediaUrl";

function remoteMediaUrl(c: Creation): string | null {
  if (c.remoteUrl?.trim()) return c.remoteUrl.trim();
  if (c.videoUrl?.trim()) return c.videoUrl.trim();
  if (!c.remoteJson) return null;
  try {
    const raw = JSON.parse(c.remoteJson) as { url?: string; video_url?: string };
    return raw.url || raw.video_url || null;
  } catch {
    return null;
  }
}

async function resolveCreationUrl(creationId: string): Promise<string> {
  const [row] = await getCreations([creationId]);
  if (!row) throw new Error(`Asset ${creationId} not found in Library.`);
  const imageUrl = parascenePublicImageUrl(row);
  if (imageUrl) return imageUrl;
  const url = remoteMediaUrl(row);
  if (
    url &&
    /^https?:\/\//i.test(url) &&
    !/^asset:\/\//i.test(url) &&
    !/localhost|127\.0\.0\.1/i.test(url)
  ) {
    return url;
  }
  throw new Error(
    `Asset ${creationId} has no public Parascene URL — sync or download it first.`,
  );
}

async function resolveCreationVideoUrl(creationId: string): Promise<string> {
  const [row] = await getCreations([creationId]);
  if (!row) throw new Error(`Asset ${creationId} not found in Library.`);
  return resolveParasceneVideoRefUrl(row);
}

async function resolveStartImageUrl(
  startFrame: StartFramePreview,
): Promise<string | null> {
  const passthrough = await resolveParasceneStartFrameImageUrl(startFrame);
  if (passthrough) return passthrough;
  if (startFrame.framePath?.trim()) {
    const uploaded = await uploadLocalImageFile(startFrame.framePath.trim(), {
      filename: "parascene-ref.jpg",
      contentType: "image/jpeg",
    });
    return uploaded.url;
  }
  return null;
}

export async function runParasceneProductVideoGeneration(opts: {
  intentId: Extract<GenerateIntentId, "video_to_video" | "reference_to_video">;
  placeholder: TimelineClip;
  timeline: readonly TimelineClip[];
  aspectRatio: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  mainAudioCreationId: string | null;
  lyricAlignment?: LyricAlignment | null;
  prompt: string;
  model: string;
  startFrame: StartFramePreview;
  mediaRefs?: GenerateMediaRefs;
  /** @deprecated Prefer mediaRefs.inputVideoAssetId */
  inputVideoCreationId?: string | null;
  /** @deprecated Prefer mediaRefs.referenceImageAssetIds */
  referenceCreationIds?: string[];
  onProgress: (note: string) => void;
  onPendingCreation?: (id: string | null) => void;
  onServiceJobId?: (id: string) => void;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  model: string;
}> {
  const serverId = parasceneServerIdForIntent(opts.intentId);
  const method = parasceneMethodForIntent(opts.intentId);
  if (serverId !== 6 || !method) {
    throw new Error(`${opts.intentId} is not supported on the Parascene server.`);
  }

  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Enter a prompt.");

  const model = opts.model.trim();
  if (!model) throw new Error("Choose a model.");

  const { durationSec } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    opts.mainAudioCreationId,
    opts.lyricAlignment ?? null,
  );

  const refs = normalizeGenerateMediaRefs(opts.mediaRefs);
  if (!refs.inputVideoAssetId && opts.inputVideoCreationId?.trim()) {
    refs.inputVideoAssetId = opts.inputVideoCreationId.trim();
  }
  if (
    refs.referenceImageAssetIds.length === 0 &&
    opts.referenceCreationIds?.length
  ) {
    refs.referenceImageAssetIds = opts.referenceCreationIds.filter(Boolean);
  }
  if (!refs.characterImageAssetId && opts.startFrame.sourceAssetId?.trim()) {
    refs.characterImageAssetId = opts.startFrame.sourceAssetId.trim();
  }
  const invalid = validateGenerateMediaRefs({
    intentId: opts.intentId,
    refs,
    modelId: model,
  });
  if (invalid) throw new Error(invalid);

  const plan = planAdvancedVideoSend({
    intentId: opts.intentId,
    lane: "parascene",
    prompt,
    model,
    aspectRatio: opts.aspectRatio,
    durationSec,
    refs,
  });
  const args: Record<string, unknown> = { ...plan.args };

  opts.onProgress(
    opts.intentId === "video_to_video"
      ? "Resolving source video…"
      : "Resolving references…",
  );
  if (plan.slotIds.images.length > 0) {
    const urls: string[] = [];
    for (const id of plan.slotIds.images) {
      if (isTimelineImageRefId(id)) {
        const still = await resolveReferenceImageStill({
          id,
          timeline: opts.timeline,
          placeholder: opts.placeholder,
          aspectRatio: opts.aspectRatio,
        });
        const url = await resolveStartImageUrl(still);
        if (!url) {
          throw new Error(
            "Could not upload the timeline still to Parascene.",
          );
        }
        urls.push(url);
      } else {
        urls.push(await resolveCreationUrl(id));
      }
    }
    args[plan.mediaFields.images] = urls;
  } else if (opts.intentId === "video_to_video") {
    const refUrl = await resolveStartImageUrl(opts.startFrame);
    if (refUrl) args.input_images = [refUrl];
  }
  if (plan.slotIds.videos.length > 0) {
    const urls: string[] = [];
    for (const id of plan.slotIds.videos) {
      urls.push(await resolveCreationVideoUrl(id));
    }
    args[plan.mediaFields.videos] = urls;
  }
  const audioUrls: string[] = [];
  if (refs.timelineAudio !== "none") {
    await attachParasceneTimelineAudioToCreateArgs({
      args,
      mode: refs.timelineAudio,
      mainAudioCreationId: opts.mainAudioCreationId,
      timeline: opts.timeline,
      placeholder: opts.placeholder,
      lyricAlignment: opts.lyricAlignment ?? null,
      onProgress: opts.onProgress,
    });
  }
  const timelineOwnsAudio =
    args.audio_clip_id != null || args.audio_creation_id != null;
  if (plan.slotIds.audios.length > 0 && !timelineOwnsAudio) {
    for (const id of plan.slotIds.audios) {
      const extra = await resolveParasceneAudioAssetForCreate(id);
      if (extra.kind === "clip") {
        if (args.audio_clip_id != null) {
          throw new Error(
            "Parascene can only send one uploaded audio clip. Remove extra audio refs or use a Parascene audio asset.",
          );
        }
        attachParasceneAudioClipId(args, extra.clipId);
      } else if (!isGenericPromptAudioUrl(extra.url)) {
        audioUrls.push(extra.url);
      }
    }
  }
  if (
    audioUrls.length > 0 &&
    args.audio_clip_id == null &&
    args.audio_creation_id == null
  ) {
    args[plan.mediaFields.audios] = audioUrls;
  }

  opts.onProgress(`Starting ${method} on Parascene…`);
  const handle = await invokeParasceneGenerate({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    serverId,
    method,
    args,
    intent: opts.intentId,
    mediaType: "video",
    target: "timeline",
    clientRequestId: opts.placeholder.id,
    label: model,
  });
  if (handle.mode === "job") {
    opts.onServiceJobId?.(handle.id);
  }
  const result = await watchParasceneGenerate(handle, {
    onUpdate: (run: ServiceRun) => {
      const note = run.progressNote?.trim();
      if (note) opts.onProgress(note);
      const pendingId = pendingCreationIdFromRun(run);
      if (pendingId) opts.onPendingCreation?.(pendingId);
    },
  });
  return {
    creationId: result.creationId,
    projectCreationIds: result.projectCreationIds,
    videosGroupId: result.videosGroupId ?? opts.videosGroupId,
    imagesGroupId: result.imagesGroupId ?? opts.imagesGroupId,
    model,
  };
}
