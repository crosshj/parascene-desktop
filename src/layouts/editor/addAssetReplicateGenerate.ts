/**
 * Replicate-backed timeline video fill (gap bridge / continue / motion match).
 */

import {
  listenReplicateRunProgress,
  replicateModelRun,
  replicatePredictionDownload,
  type ReplicateInputField,
} from "../../replicate/replicateClient";
import { getCreations } from "../../library/catalogClient";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";
import type { TimelineClip } from "../../project/types";
import {
  type AddAssetGenerationStep,
  type AddAssetGenerationStepId,
} from "./addAssetGenerate";
import {
  mapReplicateVideoFields,
  validateReplicateRun,
  type ReplicateVideoContinuity,
} from "./replicateRunConstraints";
import {
  framePathBasename,
  type StartFramePreview,
  visualLayerBeforePlaceholder,
} from "./addAssetStartFrame";
import {
  applyReplicateTweaksToInput,
  discoverReplicateTweakFields,
  normalizeReplicateTweaks,
  type ReplicateVideoTweaks,
} from "./replicateVideoTweaks";
import { recordUiOpTrace } from "./uiOpTrace";

/** Thrown when Replicate succeeded but the local download/import did not. */
export class ReplicatePendingDownloadError extends Error {
  readonly predictionId: string;

  constructor(message: string, predictionId: string) {
    super(message);
    this.name = "ReplicatePendingDownloadError";
    this.predictionId = predictionId;
  }
}

export function isDownloadRetryableError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("download failed") ||
    m.includes("download http") ||
    m.includes("download body failed") ||
    m.includes("download rate limited") ||
    m.includes("no local output file") ||
    m.includes("could not be imported") ||
    m.includes("import produced no")
  );
}

/**
 * Require non-empty local paths for image/video Replicate fields.
 * Prevents omit → model default `''` (Vidu E006 start_image got '').
 */
export function assertReplicateLocalFiles(
  localFiles: Record<string, string>,
  requiredFields: readonly string[],
): void {
  for (const field of requiredFields) {
    const name = field.trim();
    if (!name) continue;
    const path = localFiles[name]?.trim() ?? "";
    if (!path) {
      throw new Error(
        `Missing local file for Replicate input “${name}”. Refusing to create a prediction without it.`,
      );
    }
  }
}

/** Basename summary for UI diagnostics (no full paths). */
export function summarizeLocalFilesForTrace(
  localFiles: Record<string, string>,
): string {
  const keys = Object.keys(localFiles).sort();
  if (keys.length === 0) return "(none)";
  return keys
    .map((k) => `${k}=${framePathBasename(localFiles[k]) || "empty"}`)
    .join(",");
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

export function initialReplicateGenerationSteps(
  continuity: ReplicateVideoContinuity,
): AddAssetGenerationStep[] {
  if (continuity === "motion_match") {
    return [
      { id: "still", label: "Prepare character still", status: "pending" },
      { id: "end-still", label: "Prepare motion reference", status: "pending" },
      { id: "generate", label: "Generate video (Replicate)", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  if (continuity === "first_last") {
    return [
      { id: "still", label: "Prepare first frame still", status: "pending" },
      { id: "end-still", label: "Prepare last frame still", status: "pending" },
      { id: "generate", label: "Generate video (Replicate)", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  return [
    { id: "still", label: "Prepare start frame still", status: "pending" },
    { id: "generate", label: "Generate video (Replicate)", status: "pending" },
    { id: "file", label: "Add to project", status: "pending" },
  ];
}

export function initialReplicateDownloadRetrySteps(): AddAssetGenerationStep[] {
  return [
    { id: "generate", label: "Download video", status: "pending" },
    { id: "file", label: "Add to project", status: "pending" },
  ];
}

/** Resolve local path for the visual clip immediately before the placeholder. */
export async function resolveMotionReferenceVideoPath(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): Promise<string | null> {
  const layer = visualLayerBeforePlaceholder(timeline, placeholder);
  if (!layer?.clip.assetId?.trim()) return null;
  const [creation] = await getCreations([layer.clip.assetId.trim()]);
  const path = creation?.localPath?.trim() || null;
  if (!path) return null;
  const mediaType = String(creation?.mediaType ?? layer.clip.kind ?? "").toLowerCase();
  if (mediaType === "audio" || mediaType === "image") return null;
  return path;
}

export type RunReplicateAddAssetGenerationOpts = {
  placeholder: TimelineClip;
  timeline: readonly TimelineClip[];
  aspectRatio: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  prompt: string;
  continuityMode: ReplicateVideoContinuity;
  modelOwner: string;
  modelName: string;
  modelInputs: readonly ReplicateInputField[];
  durationSec: number;
  useNearestDuration?: boolean;
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
  characterFrame?: StartFramePreview | null;
  motionVideoPath?: string | null;
  tweaks?: ReplicateVideoTweaks;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
};

async function importReplicateOutput(opts: {
  outputPath: string;
  projectId: string;
  imagesGroupId: string | null;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
  steps: AddAssetGenerationStep[];
  continuity: ReplicateVideoContinuity;
  modelId: string;
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  mode: ReplicateVideoContinuity;
  model: string;
}> {
  let steps = opts.steps;
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };
  pushSteps(advanceStep(steps, "file"));
  opts.onProgress("Importing video into library…");
  const imported = await importLocalPathsForProject({
    paths: [opts.outputPath],
    projectId: opts.projectId,
  });
  const created = imported.creations[0];
  if (!created?.id) {
    const ext = opts.outputPath.includes(".")
      ? opts.outputPath.slice(opts.outputPath.lastIndexOf("."))
      : "(no extension)";
    throw new Error(
      `Import produced no Library creation from ${ext} file. The Replicate run succeeded but the output could not be imported locally.`,
    );
  }
  opts.onProgress("Adding video to project…");
  pushSteps(completeStep(steps, "file"));
  return {
    creationId: created.id,
    projectCreationIds: [created.id],
    videosGroupId: null,
    imagesGroupId: opts.imagesGroupId,
    mode: opts.continuity,
    model: opts.modelId,
  };
}

export async function runReplicateAddAssetGeneration(
  opts: RunReplicateAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  mode: ReplicateVideoContinuity;
  model: string;
}> {
  const modelId = `${opts.modelOwner}/${opts.modelName}`;
  const continuity = opts.continuityMode;
  let steps = initialReplicateGenerationSteps(continuity);
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const startPath = opts.startFrame.framePath?.trim() || null;
  const endPath = opts.endFrame?.framePath?.trim() || null;
  const characterPath =
    opts.characterFrame?.framePath?.trim() || startPath;
  const motionPath = opts.motionVideoPath?.trim() || null;

  const validation = validateReplicateRun({
    inputs: opts.modelInputs,
    continuity,
    durationSec: opts.durationSec,
    aspectRatio: opts.aspectRatio,
    useNearestDuration: opts.useNearestDuration,
    hasStartFrame: Boolean(startPath),
    hasEndFrame: Boolean(endPath),
    hasCharacterImage: Boolean(characterPath),
    hasMotionVideo: Boolean(motionPath),
    prompt: opts.prompt,
  });
  if (!validation.ok) {
    throw new Error(validation.blockers[0] ?? "Replicate run is not valid.");
  }

  const map = mapReplicateVideoFields(opts.modelInputs);
  const localFiles: Record<string, string> = {};
  const input: Record<string, unknown> = {};

  if (map.prompt) {
    input[map.prompt] = opts.prompt.trim();
  }
  if (map.duration && validation.predictDurationSec != null) {
    input[map.duration] = validation.predictDurationSec;
  }
  if (map.aspectRatio && validation.predictAspect) {
    input[map.aspectRatio] = validation.predictAspect;
  }

  const tweakFields = discoverReplicateTweakFields(opts.modelInputs);
  const tweaks = normalizeReplicateTweaks(tweakFields, opts.tweaks);
  applyReplicateTweaksToInput(input, tweakFields, tweaks);

  if (continuity === "motion_match") {
    pushSteps(advanceStep(steps, "still"));
    opts.onProgress("Preparing character still…");
    if (!characterPath || !map.characterImage) {
      throw new Error("Missing character still for motion match.");
    }
    localFiles[map.characterImage] = characterPath;
    pushSteps(completeStep(steps, "still"));

    pushSteps(advanceStep(steps, "end-still"));
    opts.onProgress("Preparing motion reference video…");
    if (!motionPath || !map.motionVideo) {
      throw new Error("Missing motion reference video.");
    }
    localFiles[map.motionVideo] = motionPath;
    pushSteps(completeStep(steps, "end-still"));
  } else if (continuity === "first_last") {
    pushSteps(advanceStep(steps, "still"));
    opts.onProgress("Preparing first frame still…");
    if (!startPath || !map.startImage) {
      throw new Error("Missing first frame still.");
    }
    localFiles[map.startImage] = startPath;
    pushSteps(completeStep(steps, "still"));

    pushSteps(advanceStep(steps, "end-still"));
    opts.onProgress("Preparing last frame still…");
    if (!endPath || !map.endImage) {
      throw new Error("Missing last frame still.");
    }
    // When start and end share the same field name (shouldn't), skip; else set end.
    if (map.endImage !== map.startImage) {
      localFiles[map.endImage] = endPath;
    }
    pushSteps(completeStep(steps, "end-still"));
  } else {
    pushSteps(advanceStep(steps, "still"));
    opts.onProgress("Preparing start frame still…");
    if (!startPath || !map.startImage) {
      throw new Error("Missing start frame still.");
    }
    localFiles[map.startImage] = startPath;
    pushSteps(completeStep(steps, "still"));
  }

  const requiredFileFields =
    continuity === "motion_match"
      ? [map.characterImage, map.motionVideo].filter(
          (v): v is string => Boolean(v),
        )
      : continuity === "first_last"
        ? [map.startImage, map.endImage].filter((v): v is string => Boolean(v))
        : [map.startImage].filter((v): v is string => Boolean(v));
  assertReplicateLocalFiles(localFiles, requiredFileFields);

  recordUiOpTrace({
    type: "add_asset_replicate_local_files",
    kind: continuity,
    ids: modelId,
    reason: summarizeLocalFilesForTrace(localFiles),
  });

  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress(`Running ${modelId}…`);
  let predictionId: string | null = null;
  const unlisten = await listenReplicateRunProgress((ev) => {
    if (ev.predictionId?.trim()) predictionId = ev.predictionId.trim();
    const msg = ev.message?.trim();
    if (msg) {
      if (
        msg.startsWith("localFiles received:") ||
        msg.startsWith("Predict input media:")
      ) {
        recordUiOpTrace({
          type: "add_asset_replicate_rust_attach",
          kind: continuity,
          ids: modelId,
          reason: msg.slice(0, 220),
        });
      }
      opts.onProgress(msg);
    } else if (ev.status) {
      opts.onProgress(`${modelId}: ${ev.status}`);
    }
  });
  let result;
  try {
    result = await replicateModelRun(
      opts.modelOwner,
      opts.modelName,
      input,
      localFiles,
      requiredFileFields,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordUiOpTrace({
      type: "add_asset_replicate_run_fail",
      kind: continuity,
      ids: modelId,
      reason: message.slice(0, 200),
    });
    if (predictionId && isDownloadRetryableError(message)) {
      throw new ReplicatePendingDownloadError(message, predictionId);
    }
    throw error;
  } finally {
    unlisten();
  }
  if (result.error || result.status === "failed" || result.status === "canceled") {
    const message =
      result.error?.trim() || `Replicate run ${result.status || "failed"}`;
    recordUiOpTrace({
      type: "add_asset_replicate_run_fail",
      kind: continuity,
      ids: result.predictionId?.trim() || predictionId || modelId,
      reason: message.slice(0, 200),
    });
    const id = result.predictionId?.trim() || predictionId;
    if (id && isDownloadRetryableError(message)) {
      throw new ReplicatePendingDownloadError(message, id);
    }
    throw new Error(message);
  }
  recordUiOpTrace({
    type: "add_asset_replicate_run_ok",
    kind: continuity,
    ids: result.predictionId?.trim() || predictionId || modelId,
    reason: `files=${summarizeLocalFilesForTrace(localFiles)}`,
  });
  const outputPath = result.localPaths.find((p) => p.trim())?.trim();
  if (!outputPath) {
    const id = result.predictionId?.trim() || predictionId;
    const message = "Replicate run finished with no local output file.";
    if (id) throw new ReplicatePendingDownloadError(message, id);
    throw new Error(message);
  }
  pushSteps(completeStep(steps, "generate"));

  try {
    return await importReplicateOutput({
      outputPath,
      projectId: opts.projectId,
      imagesGroupId: opts.imagesGroupId,
      onSteps: opts.onSteps,
      onProgress: opts.onProgress,
      steps,
      continuity,
      modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const id = result.predictionId?.trim() || predictionId;
    if (id && isDownloadRetryableError(message)) {
      throw new ReplicatePendingDownloadError(message, id);
    }
    throw error;
  }
}

export type ResumeReplicateDownloadOpts = {
  predictionId: string;
  projectId: string;
  imagesGroupId: string | null;
  continuityMode: ReplicateVideoContinuity;
  modelId: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
};

/** Retry download + import for a prediction that already succeeded on Replicate. */
export async function resumeReplicateAddAssetDownload(
  opts: ResumeReplicateDownloadOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  mode: ReplicateVideoContinuity;
  model: string;
}> {
  let steps = initialReplicateDownloadRetrySteps();
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  pushSteps(advanceStep(steps, "generate"));
  opts.onProgress("Retrying download from Replicate…");
  const unlisten = await listenReplicateRunProgress((ev) => {
    if (ev.message) opts.onProgress(ev.message);
    else if (ev.status) opts.onProgress(ev.status);
  });
  let result;
  try {
    result = await replicatePredictionDownload(opts.predictionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReplicatePendingDownloadError(message, opts.predictionId);
  } finally {
    unlisten();
  }
  if (result.error || result.status === "failed" || result.status === "canceled") {
    throw new ReplicatePendingDownloadError(
      result.error?.trim() || `Download ${result.status || "failed"}`,
      opts.predictionId,
    );
  }
  const outputPath = result.localPaths.find((p) => p.trim())?.trim();
  if (!outputPath) {
    throw new ReplicatePendingDownloadError(
      "Download finished with no local output file.",
      opts.predictionId,
    );
  }
  pushSteps(completeStep(steps, "generate"));

  try {
    return await importReplicateOutput({
      outputPath,
      projectId: opts.projectId,
      imagesGroupId: opts.imagesGroupId,
      onSteps: opts.onSteps,
      onProgress: opts.onProgress,
      steps,
      continuity: opts.continuityMode,
      modelId: opts.modelId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReplicatePendingDownloadError(message, opts.predictionId);
  }
}
