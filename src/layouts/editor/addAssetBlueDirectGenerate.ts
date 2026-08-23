/**
 * Direct-to-Blue timeline fill — local files → Blue /api → local library import.
 * Outputs stay local-only (no Parascene Creation / sync).
 */

import {
  blueJobDownload,
  blueJobWait,
  blueMethodRun,
  listenBlueRunProgress,
} from "../../blue/blueClient";
import { getCreations } from "../../library/catalogClient";
import { isolateVocalsRange, sliceAudioRange } from "../../lab/audioTools";
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
  blueMethodForTimelineFill,
  resolveBlueVideoModelId,
  type BlueVideoMethod,
} from "./blueVideoModels";
import {
  resolveAddAssetGenerationTiming,
  type StartFramePreview,
} from "./addAssetStartFrame";
import { recordUiOpTrace } from "./uiOpTrace";

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
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
  onBlueJobId?: (jobId: string) => void;
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
    result = await blueMethodRun(method, args, localFiles);
  } catch (err) {
    unlisten?.();
    throw err;
  }
  unlisten?.();

  const jobId =
    result.predictionId?.trim() ||
    (result as { jobId?: string }).jobId?.trim() ||
    "";
  if (jobId) opts.onBlueJobId?.(jobId);

  const outputPath = result.localPaths?.[0]?.trim();
  if (!outputPath) {
    if (jobId) {
      throw new BlueDirectPendingDownloadError(
        "Blue finished but no local output file was downloaded.",
        jobId,
      );
    }
    throw new Error("Blue finished but no local output file was downloaded.");
  }

  pushSteps(completeStep(steps, "generate"));
  try {
    return await importBlueOutput({
      outputPath,
      projectId: opts.projectId,
      imagesGroupId: opts.imagesGroupId,
      onSteps: opts.onSteps,
      onProgress: opts.onProgress,
      steps,
      continuity,
      modelId: model,
    });
  } catch (err) {
    if (jobId) {
      throw new BlueDirectPendingDownloadError(
        err instanceof Error ? err.message : String(err),
        jobId,
      );
    }
    throw err;
  }
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
  const result = await blueMethodRun("text2image", args);
  const outputPath = result.localPaths?.[0]?.trim();
  if (!outputPath) {
    throw new Error("Blue text-to-image finished but no local file was downloaded.");
  }
  opts.onProgress?.("Importing image into library (local-only)…");
  const imported = await importLocalPathsForProject({
    paths: [outputPath],
    projectId: opts.projectId,
  });
  const created = imported.creations[0];
  if (!created?.id) {
    throw new Error("Import produced no Library creation from Blue image output.");
  }
  return { creationId: created.id };
}
