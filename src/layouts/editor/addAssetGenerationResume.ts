/**
 * Resume in-flight add-asset generation after an app restart.
 */

import { ingestRemoteCreation } from "../../lab/ingestCreation";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import {
  runParasceneWaitCreation,
  watchParasceneGenerate,
  type ParasceneGenerateResult,
} from "../../services/generateStill";
import type {
  AddAssetDraft,
  AddAssetGenerationJob,
  TimelineClip,
} from "../../project/types";
import {
  createRunningAddAssetGenerationSession,
  type AddAssetAudioMode,
  type AddAssetContinuityMode,
  type AddAssetGenerationStep,
} from "./addAssetGenerate";
import {
  initialReplicateGenerationSteps,
  resumeReplicateAddAssetWait,
} from "./addAssetReplicateGenerate";
import { initialBlueDirectGenerationSteps } from "./addAssetBlueDirectGenerate";
import type { ReplicateVideoContinuity } from "./replicateRunConstraints";
import { addAssetClipDurationSec } from "./stagedClip";

export type ResumableAddAssetPlaceholder = {
  clip: TimelineClip;
  job: AddAssetGenerationJob;
};

/** Placeholders with a persisted remote job that can be reattached. */
export function findResumableAddAssetPlaceholders(
  timeline: readonly TimelineClip[],
): ResumableAddAssetPlaceholder[] {
  const out: ResumableAddAssetPlaceholder[] = [];
  for (const clip of timeline) {
    if (!clip.isAddAssetPlaceholder) continue;
    const job = clip.addAssetDraft?.generationJob;
    if (!job) continue;
    const hasRemote =
      Boolean(job.replicatePredictionId?.trim()) ||
      Boolean(job.pendingCreationId?.trim()) ||
      Boolean(job.blueJobId?.trim()) ||
      Boolean(job.serviceJobId?.trim());
    // "starting" without a remote id cannot be resumed — surface as failure later.
    if (!hasRemote && job.status !== "starting") continue;
    out.push({ clip, job });
  }
  return out;
}

export function draftAudioMode(draft: AddAssetDraft | undefined): AddAssetAudioMode {
  if (draft?.audioMode === "none") return "none";
  if (draft?.audioMode === "full_mix") return "full_mix";
  return "vocals";
}

export function draftContinuityMode(
  draft: AddAssetDraft | undefined,
): AddAssetContinuityMode {
  return draft?.continuityMode ?? "start_frame";
}

export type ResumeParasceneAddAssetOpts = {
  pendingCreationId?: string;
  /** Prefer watching the durable service job when present. */
  serviceJobId?: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  continuityMode: AddAssetContinuityMode;
  model: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
};

export async function resumeParasceneAddAssetGeneration(
  opts: ResumeParasceneAddAssetOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = createRunningAddAssetGenerationSession(
    "resume",
    "none",
    9,
    opts.continuityMode,
  ).steps;
  const setStep = (
    id: AddAssetGenerationStep["id"],
    status: AddAssetGenerationStep["status"],
  ) => {
    steps = steps.map((s) => (s.id === id ? { ...s, status } : s));
    opts.onSteps(steps);
  };
  setStep("generate", "active");

  const serviceJobId = opts.serviceJobId?.trim() || "";
  if (serviceJobId) {
    opts.onProgress(`Resuming service job ${serviceJobId}…`);
    const result: ParasceneGenerateResult = await watchParasceneGenerate(
      { mode: "job", id: serviceJobId },
      {
        onUpdate: (run) => {
          const note = run.progressNote?.trim();
          if (note) opts.onProgress(note);
        },
      },
    );
    setStep("generate", "done");
    setStep("file", "done");
    return {
      creationId: result.creationId,
      projectCreationIds: result.projectCreationIds,
      videosGroupId: result.videosGroupId ?? opts.videosGroupId,
      imagesGroupId: result.imagesGroupId ?? opts.imagesGroupId,
      mode: opts.continuityMode,
      model: opts.model,
    };
  }

  const pendingCreationId = opts.pendingCreationId?.trim() || "";
  if (!pendingCreationId) {
    throw new Error("No remote job id available to resume generation.");
  }

  opts.onProgress(`Resuming wait for ${pendingCreationId}…`);
  const waited = await runParasceneWaitCreation({
    creationId: pendingCreationId,
    projectId: opts.projectId,
    onProgress: opts.onProgress,
  });
  if (String(waited.status).toLowerCase() === "failed") {
    throw new Error(`Video generation failed (${waited.creationId})`);
  }
  setStep("generate", "done");
  setStep("file", "active");
  opts.onProgress("Syncing video to library…");
  const creationId = await ingestRemoteCreation(
    waited.creation as Parameters<typeof ingestRemoteCreation>[0],
  );
  opts.onProgress("Filing video into project…");
  const filed = await fileCreationIntoProjectGroup({
    creationId,
    mediaType: "video",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  setStep("file", "done");
  return {
    creationId,
    projectCreationIds: filed.projectCreationIds,
    videosGroupId: filed.groupId,
    imagesGroupId: opts.imagesGroupId,
    mode: opts.continuityMode,
    model: opts.model,
  };
}

export type ResumeReplicateWaitContext = {
  predictionId: string;
  projectId: string;
  imagesGroupId: string | null;
  continuityMode: AddAssetContinuityMode;
  modelId: string;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
};

export async function resumeReplicateWaitForPlaceholder(
  opts: ResumeReplicateWaitContext,
) {
  return resumeReplicateAddAssetWait({
    predictionId: opts.predictionId,
    projectId: opts.projectId,
    imagesGroupId: opts.imagesGroupId,
    continuityMode: opts.continuityMode as ReplicateVideoContinuity,
    modelId: opts.modelId,
    onSteps: opts.onSteps,
    onProgress: opts.onProgress,
  });
}

export function initialResumeSessionSteps(
  provider: "replicate" | "parascene_blue" | "blue_direct",
  continuityMode: AddAssetContinuityMode,
  audioMode: AddAssetAudioMode,
  durationSec: number,
) {
  const base = createRunningAddAssetGenerationSession(
    "resume",
    audioMode,
    durationSec,
    continuityMode,
  );
  if (provider === "replicate") {
    base.steps = initialReplicateGenerationSteps(
      continuityMode as ReplicateVideoContinuity,
    );
  } else if (provider === "blue_direct") {
    base.steps = initialBlueDirectGenerationSteps(continuityMode, audioMode);
  }
  base.progressNote = "Resuming generation…";
  return base;
}

export { addAssetClipDurationSec };
