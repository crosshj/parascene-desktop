import { createAuthedSdk } from "../auth/session";
import { getCreations } from "../library/catalogClient";
import type { TimelineClip } from "../project/types";
import type {
  ProposedScene,
  StoryboardGenerationStep,
} from "../project/types";
import { ingestRemoteCreation, newCreationToken } from "./ingestCreation";
import {
  extractVideoLastFrame,
  isolateVocalsRange,
  uploadLocalImageFile,
  uploadVocalsSliceClip,
} from "./audioTools";
import { fileCreationIntoProjectGroup, resolveLatestImagesGroupStill } from "./projectGroups";

function remoteMediaUrl(c: {
  remoteUrl?: string | null;
  videoUrl?: string | null;
  remoteJson?: string | null;
}): string | null {
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

export type BuildRunContext = {
  projectId: string;
  projectTitle: string;
  aspectRatio: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  mixPath: string | null;
  steps: StoryboardGenerationStep[];
  scenes: ProposedScene[];
  onProgress: (note: string) => void;
  onPendingCreation: (
    id: string | null,
    mediaType?: "image" | "video" | null,
  ) => void;
};

export type BuildStepResult = {
  creationId: string;
  mediaType: "image" | "video";
  projectCreationIds: string[];
  message: string;
};

async function resolveStillUrl(
  step: StoryboardGenerationStep,
  ctx: BuildRunContext,
): Promise<string> {
  if (step.stillSource?.mode === "project_image" && step.stillSource.creationId) {
    const [img] = await getCreations([step.stillSource.creationId]);
    const url = img ? remoteMediaUrl(img) : null;
    if (url) return url;
    throw new Error(
      "Selected project image has no remote URL — sync it into the project first",
    );
  }
  if (step.stillStepId) {
    const stillStep = ctx.steps.find((s) => s.id === step.stillStepId);
    if (stillStep?.creationId) {
      const [img] = await getCreations([stillStep.creationId]);
      const url = img ? remoteMediaUrl(img) : null;
      if (url) return url;
    }
  }
  const sdk = createAuthedSdk();
  const still = await resolveLatestImagesGroupStill({
    imagesGroupId: ctx.imagesGroupId,
    sdk,
  });
  return still.imageUrl;
}

async function resolveVideoLocalPath(
  step: StoryboardGenerationStep,
  ctx: BuildRunContext,
): Promise<string> {
  const sourceId = step.sourceStepId;
  if (!sourceId) {
    throw new Error("Pull frame step is missing source video step");
  }
  const source = ctx.steps.find((s) => s.id === sourceId);
  if (!source?.creationId) {
    throw new Error("Previous video is not ready — complete the prior lip-sync first");
  }
  const [video] = await getCreations([source.creationId]);
  const path = video?.localPath?.trim();
  if (!path) {
    throw new Error(
      "Previous video is not available locally — sync/download it before chaining frames",
    );
  }
  return path;
}

async function pullFrameFromVideoStep(
  step: StoryboardGenerationStep,
  ctx: BuildRunContext,
): Promise<BuildStepResult> {
  const sourcePath = await resolveVideoLocalPath(step, ctx);
  ctx.onProgress("Extracting last frame from previous video…");
  const frame = await extractVideoLastFrame(sourcePath);
  ctx.onProgress("Uploading frame still…");
  const uploaded = await uploadLocalImageFile(frame.path, {
    filename: `mv-chain-frame-${step.sceneId ?? "scene"}.jpg`,
    contentType: "image/jpeg",
  });
  const sdk = createAuthedSdk();
  const started = await sdk.create({
    serverId: 1,
    method: "uploadImage",
    creationToken: newCreationToken(),
    args: {
      image_url: uploaded.url,
      aspect_ratio: ctx.aspectRatio,
    },
  });
  ctx.onPendingCreation(String(started.id), "image");
  ctx.onProgress(`Waiting for frame image ${started.id}…`);
  const done = await sdk.waitForCreation(started.id, {
    onTick: (row) =>
      ctx.onProgress(`Waiting for ${started.id} (${row.status || "…"})`),
  });
  ctx.onPendingCreation(null, null);
  if (String(done.status).toLowerCase() === "failed") {
    throw new Error(`Frame upload failed (${done.id})`);
  }
  ctx.onProgress("Syncing frame to Library…");
  const id = await ingestRemoteCreation(done);
  ctx.onProgress("Filing frame into Images group…");
  const filed = await fileCreationIntoProjectGroup({
    creationId: id,
    mediaType: "image",
    projectId: ctx.projectId,
    projectTitle: ctx.projectTitle,
    imagesGroupId: ctx.imagesGroupId,
    videosGroupId: ctx.videosGroupId,
  });
  return {
    creationId: id,
    mediaType: "image",
    projectCreationIds: filed.projectCreationIds,
    message: `Last frame @ ${frame.timeSec.toFixed(2)}s — ${filed.message}`,
  };
}

export async function executeBuildStep(
  step: StoryboardGenerationStep,
  ctx: BuildRunContext,
): Promise<BuildStepResult> {
  if (step.kind === "noop" || step.kind === "place_clip") {
    throw new Error(`Step ${step.id} is not executable`);
  }

  if (step.kind === "pull_frame") {
    return pullFrameFromVideoStep(step, ctx);
  }

  const sdk = createAuthedSdk();
  const prompt = step.prompt?.trim() || "Music video scene";

  if (step.kind === "create_still") {
    const source = step.stillSource;
    let refUrl: string | null = null;
    let mutateOfId: number | undefined;

    if (source?.mode === "project_image" && source.creationId) {
      ctx.onProgress("Resolving reference image…");
      refUrl = await resolveStillUrl(step, ctx);
      const parsed = Number(source.creationId);
      if (Number.isFinite(parsed)) mutateOfId = parsed;
    } else if (
      source &&
      source.mode !== "prompt_only" &&
      (step.stillStepId || source.mode === "group_still")
    ) {
      ctx.onProgress("Resolving reference image…");
      refUrl = await resolveStillUrl(step, ctx);
    }

    const args: Record<string, unknown> = {
      prompt,
      model: "xai/grok-imagine-image",
      aspect_ratio: ctx.aspectRatio,
    };
    if (refUrl) {
      args.input_images = [refUrl];
    }

    ctx.onProgress(
      refUrl ? "Starting image create (with reference)…" : "Starting image create…",
    );
    const started = await sdk.create({
      serverId: 1,
      method: "replicate",
      creationToken: newCreationToken(),
      mutateOfId,
      args,
    });
    ctx.onPendingCreation(String(started.id), "image");
    ctx.onProgress(`Waiting for image ${started.id}…`);
    const done = await sdk.waitForCreation(started.id, {
      onTick: (row) =>
        ctx.onProgress(`Waiting for ${started.id} (${row.status || "…"})`),
    });
    ctx.onPendingCreation(null, null);
    if (String(done.status).toLowerCase() === "failed") {
      throw new Error(`Image create failed (${done.id})`);
    }
    ctx.onProgress("Syncing image to Library…");
    const id = await ingestRemoteCreation(done);
    ctx.onProgress("Filing into Images group…");
    const filed = await fileCreationIntoProjectGroup({
      creationId: id,
      mediaType: "image",
      projectId: ctx.projectId,
      projectTitle: ctx.projectTitle,
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    });
    return {
      creationId: id,
      mediaType: "image",
      projectCreationIds: filed.projectCreationIds,
      message: filed.message,
    };
  }

  if (step.kind === "create_video") {
    ctx.onProgress("Resolving still for i2v…");
    const imageUrl = await resolveStillUrl(step, ctx);
    ctx.onProgress("Starting image→video…");
    const started = await sdk.create({
      serverId: 6,
      method: "image2video",
      creationToken: newCreationToken(),
      args: {
        prompt,
        model: "ltx_i2v",
        aspect_ratio: ctx.aspectRatio,
        input_images: [imageUrl],
      },
    });
    ctx.onPendingCreation(String(started.id), "video");
    ctx.onProgress(`Waiting for video ${started.id}…`);
    const done = await sdk.waitForCreation(started.id, {
      onTick: (row) =>
        ctx.onProgress(`Waiting for ${started.id} (${row.status || "…"})`),
    });
    ctx.onPendingCreation(null, null);
    if (String(done.status).toLowerCase() === "failed") {
      throw new Error(`Video create failed (${done.id})`);
    }
    ctx.onProgress("Syncing video to Library…");
    const id = await ingestRemoteCreation(done);
    ctx.onProgress("Filing into Videos group…");
    const filed = await fileCreationIntoProjectGroup({
      creationId: id,
      mediaType: "video",
      projectId: ctx.projectId,
      projectTitle: ctx.projectTitle,
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    });
    return {
      creationId: id,
      mediaType: "video",
      projectCreationIds: filed.projectCreationIds,
      message: filed.message,
    };
  }

  if (step.kind === "a2v") {
    const slice = step.vocalSlice;
    if (!slice) {
      throw new Error("Lip-sync step is missing vocal slice timing");
    }
    if (!ctx.mixPath) {
      throw new Error(
        "Main audio is not available locally — sync/download the song first",
      );
    }
    ctx.onProgress(
      `Slicing vocals ${slice.inSec.toFixed(1)}–${slice.outSec.toFixed(1)}s…`,
    );
    const vocalsSlice = await isolateVocalsRange({
      sourcePath: ctx.mixPath,
      inSec: slice.inSec,
      outSec: slice.outSec,
    });
    const durationSec = Math.max(0.1, slice.outSec - slice.inSec);
    ctx.onProgress("Uploading vocals clip…");
    const { clipId } = await uploadVocalsSliceClip(vocalsSlice.path, {
      title: `MV vocals ${slice.inSec}–${slice.outSec}s`,
      durationSec,
    });
    ctx.onProgress("Resolving still for a2v…");
    const imageUrl = await resolveStillUrl(step, ctx);
    ctx.onProgress("Starting a2v…");
    const started = await sdk.create({
      serverId: 6,
      method: "audio2video",
      creationToken: newCreationToken(),
      args: {
        prompt,
        model: "ltx_a2v",
        aspect_ratio: ctx.aspectRatio,
        input_images: [imageUrl],
        audio_clip_id: Number(clipId),
      },
    });
    ctx.onPendingCreation(String(started.id), "video");
    ctx.onProgress(`Waiting for a2v ${started.id}…`);
    const done = await sdk.waitForCreation(started.id, {
      onTick: (row) =>
        ctx.onProgress(`Waiting for ${started.id} (${row.status || "…"})`),
    });
    ctx.onPendingCreation(null, null);
    if (String(done.status).toLowerCase() === "failed") {
      throw new Error(`a2v failed (${done.id})`);
    }
    ctx.onProgress("Syncing a2v to Library…");
    const id = await ingestRemoteCreation(done);
    ctx.onProgress("Filing into Videos group…");
    const filed = await fileCreationIntoProjectGroup({
      creationId: id,
      mediaType: "video",
      projectId: ctx.projectId,
      projectTitle: ctx.projectTitle,
      imagesGroupId: ctx.imagesGroupId,
      videosGroupId: ctx.videosGroupId,
    });
    return {
      creationId: id,
      mediaType: "video",
      projectCreationIds: filed.projectCreationIds,
      message: filed.message,
    };
  }

  throw new Error(`Unknown step kind: ${step.kind}`);
}

export function resolvePlaceClipAsset(
  step: StoryboardGenerationStep,
  steps: StoryboardGenerationStep[],
): { creationId: string; mediaType: "image" | "video" } | null {
  const sourceId = step.sourceStepId;
  if (!sourceId) return null;
  const source = steps.find((s) => s.id === sourceId);
  if (source?.creationId) {
    const mediaType =
      source.kind === "create_still" || source.kind === "pull_frame"
        ? "image"
        : "video";
    return { creationId: source.creationId, mediaType };
  }
  return null;
}

export function placeSceneOnTimeline(
  timeline: TimelineClip[],
  scene: ProposedScene,
  creationId: string,
  mediaType: "image" | "video",
): TimelineClip[] {
  const clipId = `mv-${scene.id}`;
  const clip: TimelineClip = {
    id: clipId,
    label: scene.title?.trim() || scene.note?.trim() || scene.id,
    startSec: scene.startSec,
    endSec: scene.endSec,
    assetId: creationId,
    kind: mediaType,
    lane: "video",
    transform: mediaType === "image" ? "hold" : undefined,
    framing: "fill",
  };
  const without = timeline.filter((c) => c.id !== clipId);
  return [...without, clip].sort((a, b) => a.startSec - b.startSec);
}

export async function completePlaceStep(
  step: StoryboardGenerationStep,
  steps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
  timeline: TimelineClip[],
): Promise<{ timeline: TimelineClip[]; creationId: string }> {
  const asset = resolvePlaceClipAsset(step, steps);
  if (!asset) {
    throw new Error("Source asset for placement is not ready");
  }
  const scene = scenes.find((s) => s.id === step.sceneId);
  if (!scene) {
    throw new Error("Scene not found for placement");
  }
  const nextTimeline = placeSceneOnTimeline(
    timeline,
    scene,
    asset.creationId,
    asset.mediaType,
  );
  return { timeline: nextTimeline, creationId: asset.creationId };
}
