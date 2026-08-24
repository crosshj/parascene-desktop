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
  /** Optional driving / source video (V2V). */
  inputVideoCreationId?: string | null;
  /** Optional reference stills (R2V / V2V models that need ref image). */
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

  const args: Record<string, unknown> = {
    prompt,
    model,
    aspect_ratio: opts.aspectRatio,
  };
  if (durationSec > 0) args.duration_seconds = durationSec;

  if (opts.intentId === "video_to_video") {
    const videoId =
      opts.inputVideoCreationId?.trim() ||
      opts.startFrame.sourceAssetId?.trim() ||
      "";
    if (!videoId) {
      throw new Error(
        "Choose a source video (timeline neighbor or Assets video).",
      );
    }
    opts.onProgress("Resolving source video…");
    const videoUrl = await resolveCreationUrl(videoId);
    args.input_video_urls = [videoUrl];

    const refUrl = await resolveStartImageUrl(opts.startFrame);
    if (refUrl) args.input_images = [refUrl];
  } else {
    const refs = opts.referenceCreationIds ?? [];
    const startId = opts.startFrame.sourceAssetId?.trim();
    const allIds = [...refs];
    if (startId && !allIds.includes(startId)) allIds.unshift(startId);
    if (allIds.length === 0) {
      throw new Error("Add at least one reference image from Assets.");
    }
    opts.onProgress("Resolving reference images…");
    const urls: string[] = [];
    for (const id of allIds) {
      urls.push(await resolveCreationUrl(id));
    }
    args.input_images = urls;
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
