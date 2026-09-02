/**
 * Direct-to-Blue timeline fill — local files → Blue /api → local library import.
 * Outputs stay local-only (no Parascene Creation / sync).
 */

import {
  blueJobDownload,
  blueJobWait,
  listenBlueRunProgress,
} from "../../blue/blueClient";
import {
  invokeBlueGenerateStill,
  watchLocalGenerateStill,
} from "../../services/generateStill";
import { getCreations } from "../../library/catalogClient";
import {
  isolateVocalsRange,
  sliceAudioRange,
} from "../../lab/audioTools";
import { buildBlueT2vCreateArgs } from "../../lab/blueT2vGeneration";
import { buildFlf2vCreateArgs } from "../../lab/flf2vGeneration";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";
import type { AddAssetBlueModel, TimelineClip } from "../../project/types";
import {
  type AddAssetGenerationStep,
  type AddAssetGenerationStepId,
  buildAddAssetGenerationPrompt,
  type AddAssetAudioMode,
  type AddAssetContinuityMode,
} from "./addAssetGenerate";
import {
  blueMethodForIntent,
  blueMethodForTimelineFill,
  resolveBlueVideoModelId,
  type BlueVideoMethod,
} from "./blueVideoModels";
import {
  resolveAddAssetGenerationTiming,
  type StartFramePreview,
} from "./addAssetStartFrame";
import { recordUiOpTrace } from "./uiOpTrace";
import type { GenerateIntentId } from "./previewIntent";
import {
  normalizeGenerateMediaRefs,
  validateGenerateMediaRefs,
  type GenerateMediaRefs,
} from "./generateMediaRefs";
import { planAdvancedVideoSend } from "./generateAdvancedVideoSend";
import { resolveLocalMediaPaths } from "./resolveLocalMedia";
import { slicePlaceholderTimelineAudio } from "./timelineReferenceAudio";
import { resolveReferenceImageStillPaths } from "./timelineReferenceImages";

/** Thrown when Blue succeeded remotely but local download/import failed. */
export class BlueDirectPendingDownloadError extends Error {
  readonly blueJobId: string;

  constructor(message: string, blueJobId: string) {
    super(message);
    this.name = "BlueDirectPendingDownloadError";
    this.blueJobId = blueJobId;
  }
}

function setStep(
  steps: AddAssetGenerationStep[],
  id: AddAssetGenerationStepId,
  status: AddAssetGenerationStep["status"],
): AddAssetGenerationStep[] {
  return steps.map((step) =>
    step.id === id ? { ...step, status } : step,
  );
}

function advanceStep(
  steps: AddAssetGenerationStep[],
  id: AddAssetGenerationStepId,
): AddAssetGenerationStep[] {
  const next = setStep(steps, id, "active");
  const order = steps.map((s) => s.id);
  const idx = order.indexOf(id);
  return next.map((step) => {
    const stepIdx = order.indexOf(step.id);
    if (stepIdx < idx && step.status !== "done") {
      return { ...step, status: "done" as const };
    }
    return step;
  });
}

function completeStep(
  steps: AddAssetGenerationStep[],
  id: AddAssetGenerationStepId,
): AddAssetGenerationStep[] {
  return setStep(advanceStep(steps, id), id, "done");
}

export function initialBlueDirectGenerationSteps(
  continuity: AddAssetContinuityMode,
  audioMode: AddAssetAudioMode,
): AddAssetGenerationStep[] {
  if (continuity === "none") {
    return [
      { id: "generate", label: "Generate video (Blue)", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  if (continuity === "first_last") {
    return [
      { id: "still", label: "Prepare first frame", status: "pending" },
      { id: "end-still", label: "Prepare last frame", status: "pending" },
      { id: "generate", label: "Generate video (Blue)", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  const steps: AddAssetGenerationStep[] = [
    { id: "still", label: "Prepare start frame", status: "pending" },
  ];
  if (audioMode !== "none") {
    steps.push(
      { id: "vocals", label: "Prepare audio slice", status: "pending" },
      { id: "upload-audio", label: "Stage audio for Blue", status: "pending" },
    );
  }
  steps.push(
    { id: "generate", label: "Generate video (Blue)", status: "pending" },
    { id: "file", label: "Add to project", status: "pending" },
  );
  return steps;
}

export function initialBlueDirectDownloadRetrySteps(): AddAssetGenerationStep[] {
  return [
    { id: "generate", label: "Download video", status: "pending" },
    { id: "file", label: "Add to project", status: "pending" },
  ];
}

export type RunBlueDirectAddAssetGenerationOpts = {
  placeholder: TimelineClip;
  timeline: readonly TimelineClip[];
  aspectRatio: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  mainAudioCreationId: string | null;
  lyricAlignment: import("../../project/types").LyricAlignment | null;
  prompt: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode;
  blueModel?: AddAssetBlueModel;
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
  intentId?: GenerateIntentId;
  mediaRefs?: GenerateMediaRefs;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
  onBlueJobId?: (jobId: string) => void;
  /** Durable service_invoke job id for remount / restart resume. */
  onServiceJobId?: (jobId: string) => void;
};

async function importBlueOutput(opts: {
  outputPath: string;
  projectId: string;
  imagesGroupId: string | null;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
  steps: AddAssetGenerationStep[];
  continuity: AddAssetContinuityMode;
  modelId: string;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = opts.steps;
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };
  pushSteps(advanceStep(steps, "file"));
  opts.onProgress("Importing video into library (local-only)…");
  const imported = await importLocalPathsForProject({
    paths: [opts.outputPath],
    projectId: opts.projectId,
  });
  const created = imported.creations[0];
  if (!created?.id) {
    throw new Error(
      "Import produced no Library creation. The Blue run succeeded but the output could not be imported locally.",
    );
  }
  opts.onProgress("Adding video to project…");
  pushSteps(completeStep(steps, "file"));
  return {
    creationId: created.id,
    projectCreationIds: [created.id],
    videosGroupId: null,
    imagesGroupId: opts.imagesGroupId,
    startFrameCreationId: null,
    endFrameCreationId: null,
    mode: opts.continuity,
    model: opts.modelId,
  };
}

function requireLocalFrame(
  frame: StartFramePreview | null | undefined,
  label: string,
): string {
  const path = frame?.framePath?.trim();
  if (!path) {
    throw new Error(
      `${label} needs a local frame file for Direct to Blue. Pick a project image or place the clip next to timeline media.`,
    );
  }
  return path;
}

export async function runBlueDirectAddAssetGeneration(
  opts: RunBlueDirectAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  const continuity = opts.continuityMode;
  if (continuity === "motion_match") {
    throw new Error("Motion match requires a Replicate model.");
  }

  if (
    opts.intentId === "video_to_video" ||
    opts.intentId === "reference_to_video"
  ) {
    return runBlueDirectAdvancedVideo(opts);
  }

  const audioMode = continuity === "none" ? "none" : opts.audioMode;
  let steps = initialBlueDirectGenerationSteps(continuity, audioMode);
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);
  const { durationSec: durationSeconds, songRange } =
    resolveAddAssetGenerationTiming(
      opts.timeline,
      opts.placeholder,
      opts.mainAudioCreationId,
      opts.lyricAlignment,
    );

  let method: BlueVideoMethod;
  let model: string;
  let args: Record<string, unknown>;
  let localFiles: Record<string, string | string[]> = {};

  if (continuity === "none") {
    if (!fullPrompt.trim()) {
      throw new Error("Enter a prompt for text-to-video.");
    }
    method = "text2video";
    model = resolveBlueVideoModelId({
      selected: opts.blueModel,
      method,
      continuity,
      blueDirect: true,
    });
    args = buildBlueT2vCreateArgs({
      prompt: fullPrompt,
      aspectRatio: opts.aspectRatio,
      model: model as "wan_t2v" | "ltx_t2v",
      durationSeconds,
    }) as unknown as Record<string, unknown>;
    args.model = model;

    pushSteps(advanceStep(steps, "generate"));
    opts.onProgress("Running on Direct to Blue…");
    void recordUiOpTrace({
      type: "blue_direct_generate",
      reason: `${method}/${model}`,
    });

    let unlistenT2v: (() => void) | undefined;
    try {
      unlistenT2v = await listenBlueRunProgress((ev) => {
        const note = ev.message?.trim() || ev.status?.trim();
        if (note) opts.onProgress(note);
        const jobId = ev.predictionId?.trim();
        if (jobId) opts.onBlueJobId?.(jobId);
      });
    } catch {
      /* progress optional */
    }

    try {
      const handle = await invokeBlueGenerateStill({
        method,
        args,
        projectId: opts.projectId,
        target: "timeline",
        clientRequestId: opts.placeholder.id,
        label: model,
      });
      if (handle.mode === "job") {
        opts.onServiceJobId?.(handle.id);
      }
      const result = await watchLocalGenerateStill(handle, {
        onUpdate: (run) => {
          const note = run.progressNote?.trim();
          if (!note) return;
          if (
            note === "Blue generate…" ||
            note === "Starting…" ||
            note === "Waiting for Blue…"
          ) {
            return;
          }
          opts.onProgress(note);
        },
      });
      unlistenT2v?.();
      if (result.predictionId?.trim()) {
        opts.onBlueJobId?.(result.predictionId.trim());
      }
      pushSteps(completeStep(steps, "generate"));
      pushSteps(advanceStep(steps, "file"));
      pushSteps(completeStep(steps, "file"));
      return {
        creationId: result.creationId,
        projectCreationIds: [result.creationId],
        videosGroupId: null,
        imagesGroupId: opts.imagesGroupId,
        startFrameCreationId: null,
        endFrameCreationId: null,
        mode: continuity,
        model,
      };
    } catch (err) {
      unlistenT2v?.();
      throw err;
    }
  } else if (continuity === "first_last") {
    pushSteps(advanceStep(steps, "still"));
    const firstPath = requireLocalFrame(opts.startFrame, "First frame");
    pushSteps(completeStep(steps, "still"));
    pushSteps(advanceStep(steps, "end-still"));
    const lastPath = requireLocalFrame(opts.endFrame, "Last frame");
    pushSteps(completeStep(steps, "end-still"));
    method = "image2video";
    model = resolveBlueVideoModelId({
      selected: opts.blueModel,
      method,
      continuity,
      blueDirect: true,
    });
    const built = buildFlf2vCreateArgs({
      prompt: fullPrompt,
      aspectRatio: opts.aspectRatio,
      firstImageUrl: "local:first",
      lastImageUrl: "local:last",
      durationSeconds,
    });
    args = {
      prompt: built.prompt,
      model,
      aspect_ratio: built.aspect_ratio,
      ...(built.duration_seconds != null
        ? { duration_seconds: built.duration_seconds }
        : {}),
    };
    localFiles = { input_images: [firstPath, lastPath] };
  } else {
    // start_frame (± audio)
    pushSteps(advanceStep(steps, "still"));
    const startPath = requireLocalFrame(opts.startFrame, "Start frame");
    pushSteps(completeStep(steps, "still"));

    method = blueMethodForTimelineFill({ continuity, audioMode });
    model = resolveBlueVideoModelId({
      selected: opts.blueModel,
      method,
      continuity,
      blueDirect: true,
    });

    if (method === "audio2video") {
      const audioId = opts.mainAudioCreationId?.trim();
      if (!audioId) {
        throw new Error(
          "Add main audio to the timeline (or set it in Lab) before generating.",
        );
      }
      const inSec = songRange.startSec;
      const sliceOutSec = inSec + durationSeconds;
      if (!(sliceOutSec > inSec)) {
        throw new Error("Invalid song time range for this clip.");
      }
      pushSteps(advanceStep(steps, "vocals"));
      opts.onProgress(
        audioMode === "full_mix"
          ? `Preparing ${durationSeconds.toFixed(1)}s audio slice…`
          : `Preparing ${durationSeconds.toFixed(1)}s vocals stem…`,
      );
      const [audioRow] = await getCreations([audioId]);
      const mixPath = audioRow?.localPath?.trim();
      if (!mixPath) {
        throw new Error("Main audio is not available locally yet.");
      }
      const audioSlice =
        audioMode === "full_mix"
          ? await sliceAudioRange({
              sourcePath: mixPath,
              inSec,
              outSec: sliceOutSec,
            })
          : await isolateVocalsRange({
              sourcePath: mixPath,
              inSec,
              outSec: sliceOutSec,
            });
      pushSteps(completeStep(steps, "vocals"));
      pushSteps(advanceStep(steps, "upload-audio"));
      opts.onProgress("Staging audio for Blue…");
      localFiles = {
        input_images: [startPath],
        input_audio_urls: [audioSlice.path],
      };
      pushSteps(completeStep(steps, "upload-audio"));
      args = {
        prompt: fullPrompt.trim(),
        model,
        aspect_ratio: opts.aspectRatio,
        ...(durationSeconds > 0 ? { duration_seconds: durationSeconds } : {}),
      };
    } else {
      args = {
        prompt: fullPrompt.trim(),
        model,
        aspect_ratio: opts.aspectRatio,
        ...(durationSeconds > 0 ? { duration_seconds: durationSeconds } : {}),
      };
      localFiles = { input_images: [startPath] };
    }
  }

  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress("Running on Direct to Blue…");
  void recordUiOpTrace({
    type: "blue_direct_generate",
    reason: `${method}/${model}`,
  });

  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listenBlueRunProgress((ev) => {
      const note = ev.message?.trim() || ev.status?.trim();
      if (note) opts.onProgress(note);
      const jobId = ev.predictionId?.trim();
      if (jobId) opts.onBlueJobId?.(jobId);
    });
  } catch {
    /* progress optional */
  }

  let result;
  try {
    const handle = await invokeBlueGenerateStill({
      method,
      args,
      localFiles,
      projectId: opts.projectId,
      target: "timeline",
      clientRequestId: opts.placeholder.id,
      label: model,
    });
    if (handle.mode === "job") {
      opts.onServiceJobId?.(handle.id);
    }
    result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (!note) return;
        if (
          note === "Blue generate…" ||
          note === "Starting…" ||
          note === "Waiting for Blue…"
        ) {
          return;
        }
        opts.onProgress(note);
      },
    });
  } catch (err) {
    unlisten?.();
    throw err;
  }
  unlisten?.();

  if (result.predictionId?.trim()) {
    opts.onBlueJobId?.(result.predictionId.trim());
  }
  if (!result.creationId?.trim()) {
    const jobId = result.predictionId?.trim() || "";
    if (jobId) {
      throw new BlueDirectPendingDownloadError(
        "Blue finished but no creation was imported.",
        jobId,
      );
    }
    throw new Error("Blue finished but no creation was imported.");
  }

  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));
  return {
    creationId: result.creationId,
    projectCreationIds: [result.creationId],
    videosGroupId: null,
    imagesGroupId: opts.imagesGroupId,
    startFrameCreationId: null,
    endFrameCreationId: null,
    mode: continuity,
    model,
  };
}

export async function resumeBlueDirectAddAssetWait(opts: {
  blueJobId: string;
  projectId: string;
  imagesGroupId: string | null;
  continuityMode: AddAssetContinuityMode;
  model: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = initialBlueDirectDownloadRetrySteps();
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };
  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress("Waiting for Blue job…");
  const result = await blueJobWait(opts.blueJobId);
  const outputPath = result.localPaths?.[0]?.trim();
  if (!outputPath) {
    throw new BlueDirectPendingDownloadError(
      "Blue job finished but no local output file was downloaded.",
      opts.blueJobId,
    );
  }
  pushSteps(completeStep(steps, "generate"));
  return importBlueOutput({
    outputPath,
    projectId: opts.projectId,
    imagesGroupId: opts.imagesGroupId,
    onSteps: opts.onSteps,
    onProgress: opts.onProgress,
    steps,
    continuity: opts.continuityMode,
    modelId: opts.model,
  });
}

/** Resume a Blue Direct generate that was started via service_invoke. */
export async function resumeBlueDirectServiceJob(opts: {
  serviceJobId: string;
  projectId: string;
  imagesGroupId: string | null;
  continuityMode: AddAssetContinuityMode;
  model: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = initialBlueDirectGenerationSteps(opts.continuityMode, "none");
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };
  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress(`Resuming service job ${opts.serviceJobId}…`);
  const result = await watchLocalGenerateStill(
    { mode: "job", id: opts.serviceJobId },
    {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (!note) return;
        if (
          note === "Blue generate…" ||
          note === "Starting…" ||
          note === "Waiting for Blue…"
        ) {
          return;
        }
        opts.onProgress(note);
      },
    },
  );
  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));
  return {
    creationId: result.creationId,
    projectCreationIds: [result.creationId],
    videosGroupId: null,
    imagesGroupId: opts.imagesGroupId,
    mode: opts.continuityMode,
    model: opts.model,
  };
}

export async function resumeBlueDirectAddAssetDownload(opts: {
  blueJobId: string;
  projectId: string;
  imagesGroupId: string | null;
  continuityMode: AddAssetContinuityMode;
  model: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = initialBlueDirectDownloadRetrySteps();
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };
  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress("Downloading Blue output…");
  const result = await blueJobDownload(opts.blueJobId);
  const outputPath = result.localPaths?.[0]?.trim();
  if (!outputPath) {
    throw new BlueDirectPendingDownloadError(
      "Blue download produced no local output file.",
      opts.blueJobId,
    );
  }
  pushSteps(completeStep(steps, "generate"));
  return importBlueOutput({
    outputPath,
    projectId: opts.projectId,
    imagesGroupId: opts.imagesGroupId,
    onSteps: opts.onSteps,
    onProgress: opts.onProgress,
    steps,
    continuity: opts.continuityMode,
    modelId: opts.model,
  });
}

/** Library Text to Image via Direct to Blue (`text2image`). */
export async function runBlueDirectTextToImage(opts: {
  prompt: string;
  aspectRatio: string;
  projectId: string;
  model?: string;
  onProgress?: (note: string) => void;
}): Promise<{ creationId: string }> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("Enter a prompt for text-to-image.");
  opts.onProgress?.("Running Text to Image on Direct to Blue…");
  const args: Record<string, unknown> = {
    prompt,
    aspect_ratio: opts.aspectRatio,
  };
  const model = opts.model?.trim();
  if (!model) {
    throw new Error("Choose a Blue text-to-image model.");
  }
  args.model = model;
  const unlisten = await listenBlueRunProgress((ev) => {
    if (ev.message?.trim()) opts.onProgress?.(ev.message.trim());
    else if (ev.status) opts.onProgress?.(`Blue: ${ev.status}`);
  });
  let result;
  try {
    const handle = await invokeBlueGenerateStill({
      method: "text2image",
      args,
      projectId: opts.projectId,
      target: "assets",
      label: model,
    });
    result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (note) opts.onProgress?.(note);
      },
    });
  } finally {
    unlisten();
  }
  const outputPath = result.localPaths[0]?.trim();
  if (!outputPath) {
    throw new Error("Blue text-to-image finished but no local file was downloaded.");
  }
  return { creationId: result.creationId };
}

async function runBlueDirectAdvancedVideo(
  opts: RunBlueDirectAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  const intentId = opts.intentId;
  if (intentId !== "video_to_video" && intentId !== "reference_to_video") {
    throw new Error("Advanced Blue video requires Video to Video or Refs to Video.");
  }
  const method = blueMethodForIntent(intentId);
  if (!method) throw new Error("No Blue method for this intent.");

  const refs = normalizeGenerateMediaRefs(opts.mediaRefs);
  const model = resolveBlueVideoModelId({
    selected: opts.blueModel,
    method,
    continuity: "start_frame",
    blueDirect: true,
  });
  const invalid = validateGenerateMediaRefs({
    intentId,
    refs,
    modelId: model,
  });
  if (!invalid && !opts.prompt.trim()) throw new Error("Enter a prompt.");
  if (invalid) throw new Error(invalid);

  const { durationSec } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    opts.mainAudioCreationId,
    opts.lyricAlignment,
  );

  const plan = planAdvancedVideoSend({
    intentId,
    lane: "blue_direct",
    prompt: buildAddAssetGenerationPrompt(opts.prompt),
    model,
    aspectRatio: opts.aspectRatio,
    durationSec,
    refs,
  });

  let steps = initialBlueDirectGenerationSteps(
    "start_frame",
    refs.timelineAudio === "none" ? "none" : refs.timelineAudio,
  );
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  pushSteps(advanceStep(steps, "still"));
  opts.onProgress("Preparing local media for Blue…");
  const args: Record<string, unknown> = { ...plan.args };
  const localFiles: Record<string, string | string[]> = {};

  if (plan.slotIds.videos.length > 0) {
    localFiles[plan.mediaFields.videos] = await resolveLocalMediaPaths(
      plan.slotIds.videos,
    );
  }
  if (plan.slotIds.images.length > 0) {
    opts.onProgress("Preparing reference images for Blue…");
    localFiles[plan.mediaFields.images] = await resolveReferenceImageStillPaths(
      plan.slotIds.images,
      {
        timeline: opts.timeline,
        placeholder: opts.placeholder,
        aspectRatio: opts.aspectRatio,
      },
    );
  }
  const audioPaths: string[] = [];
  if (refs.timelineAudio !== "none") {
    pushSteps(advanceStep(steps, "vocals"));
    opts.onProgress(
      refs.timelineAudio === "vocals"
        ? "Preparing timeline vocals slice…"
        : "Preparing timeline audio slice…",
    );
    const sliced = await slicePlaceholderTimelineAudio({
      mode: refs.timelineAudio,
      mainAudioCreationId: opts.mainAudioCreationId,
      timeline: opts.timeline,
      placeholder: opts.placeholder,
      lyricAlignment: opts.lyricAlignment,
    });
    audioPaths.push(sliced.path);
    pushSteps(completeStep(steps, "vocals"));
    pushSteps(advanceStep(steps, "upload-audio"));
    pushSteps(completeStep(steps, "upload-audio"));
  }
  if (plan.slotIds.audios.length > 0) {
    audioPaths.push(
      ...(await resolveLocalMediaPaths(plan.slotIds.audios)),
    );
  }
  if (audioPaths.length > 0) {
    localFiles[plan.mediaFields.audios] = audioPaths;
  }
  pushSteps(completeStep(steps, "still"));

  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress("Running on Direct to Blue…");
  void recordUiOpTrace({
    type: "blue_direct_generate",
    reason: `${method}/${model}`,
  });

  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listenBlueRunProgress((ev) => {
      const note = ev.message?.trim() || ev.status?.trim();
      if (note) opts.onProgress(note);
      const jobId = ev.predictionId?.trim();
      if (jobId) opts.onBlueJobId?.(jobId);
    });
  } catch {
    /* progress optional */
  }

  let result;
  try {
    const handle = await invokeBlueGenerateStill({
      method,
      args,
      localFiles,
      projectId: opts.projectId,
      target: "timeline",
      clientRequestId: opts.placeholder.id,
      label: model,
    });
    if (handle.mode === "job") {
      opts.onServiceJobId?.(handle.id);
    }
    result = await watchLocalGenerateStill(handle, {
      onUpdate: (run) => {
        const note = run.progressNote?.trim();
        if (!note) return;
        if (
          note === "Blue generate…" ||
          note === "Starting…" ||
          note === "Waiting for Blue…"
        ) {
          return;
        }
        opts.onProgress(note);
      },
    });
  } catch (err) {
    unlisten?.();
    throw err;
  }
  unlisten?.();

  if (result.predictionId?.trim()) {
    opts.onBlueJobId?.(result.predictionId.trim());
  }
  if (!result.creationId?.trim()) {
    const jobId = result.predictionId?.trim() || "";
    if (jobId) {
      throw new BlueDirectPendingDownloadError(
        "Blue finished but no creation was imported.",
        jobId,
      );
    }
    throw new Error("Blue finished but no creation was imported.");
  }

  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));
  return {
    creationId: result.creationId,
    projectCreationIds: [result.creationId],
    videosGroupId: null,
    imagesGroupId: opts.imagesGroupId,
    startFrameCreationId: refs.characterImageAssetId,
    endFrameCreationId: null,
    mode: "start_frame",
    model,
  };
}
