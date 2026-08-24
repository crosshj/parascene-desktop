import {
  isolateVocalsRange,
  uploadLocalImageFile,
  sliceAudioRange,
  uploadVocalsSliceClip,
} from "../../lab/audioTools";
import {
  buildBlueT2vCreateArgs,
  LTX_T2V_MODEL,
  WAN_T2V_MODEL,
} from "../../lab/blueT2vGeneration";
import {
  buildFlf2vCreateArgs,
  FLF2V_MODEL,
} from "../../lab/flf2vGeneration";
import {
  buildLtxI2vCreateArgs,
  LTX_I2V_MODEL,
} from "../../lab/ltxI2vGeneration";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import { getCreations } from "../../library/catalogClient";
import type { ReplicateInputField } from "../../replicate/replicateClient";
import type {
  AddAssetBlueModel,
  AddAssetGeneration,
  AddAssetGenerationMode,
  LyricAlignment,
  TimelineClip,
} from "../../project/types";
import {
  invokeParasceneGenerate,
  pendingCreationIdFromRun,
  watchParasceneGenerate,
} from "../../services/generateStill";
import { runLabParasceneGenerate } from "../../services/labParasceneGenerate";
import type { ServiceRun } from "../../services/types";
import {
  ADD_ASSET_TIMELINE_DURATION_SEC,
  addAssetClipDurationSec,
  clampAddAssetDurationSec,
} from "./stagedClip";
import { resolveAddAssetGenerationTiming } from "./addAssetStartFrame";
import {
  resolveParasceneStartFrameImageUrl,
  startFrameIsReady,
  type StartFramePreview,
} from "./addAssetStartFrame";
import { runReplicateAddAssetGeneration } from "./addAssetReplicateGenerate";
import { runBlueDirectAddAssetGeneration } from "./addAssetBlueDirectGenerate";
import { runParasceneProductVideoGeneration } from "./runParasceneProductVideo";
import { resolveAddAssetIntent, type GenerateIntentId } from "./previewIntent";
import { isWanFamilyBlueModel } from "./blueVideoModels";
import type { ReplicateVideoContinuity } from "./replicateRunConstraints";

export type AddAssetGenerationStepId =
  | "vocals"
  | "upload-audio"
  | "still"
  | "end-still"
  | "generate"
  | "file";

export type AddAssetGenerationStep = {
  id: AddAssetGenerationStepId;
  label: string;
  status: "pending" | "active" | "done";
};

/**
 * Baseline A2V turnaround for a default-length clip (~9s → ~2.5 min).
 * Progress bar fills over {@link addAssetGenerationExpectedMs} then cycles.
 */
export const ADD_ASSET_GENERATION_EXPECTED_MS = 150_000;

/** Scale expected wall-clock time from clip duration (linear with baseline 9s). */
export function addAssetGenerationExpectedMs(durationSec: number): number {
  const duration = clampAddAssetDurationSec(durationSec);
  return (
    (duration / ADD_ASSET_TIMELINE_DURATION_SEC) * ADD_ASSET_GENERATION_EXPECTED_MS
  );
}

export type AddAssetGenerationProgress = {
  percent: number;
  indeterminate: boolean;
};

export function addAssetGenerationProgress(
  elapsedMs: number,
  expectedMs: number = ADD_ASSET_GENERATION_EXPECTED_MS,
): AddAssetGenerationProgress {
  const expected = Math.max(1, expectedMs);
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed >= expected) {
    return { percent: 100, indeterminate: true };
  }
  return {
    percent: Math.min(100, (elapsed / expected) * 100),
    indeterminate: false,
  };
}

/** Background generation tracked while the modal may be closed. */
export type AddAssetGenerationSession = {
  clipId: string;
  phase: "running" | "error";
  startedAtMs: number;
  /** Wall-clock estimate used by the progress bar (scaled by clip duration). */
  expectedMs: number;
  steps: AddAssetGenerationStep[];
  progressNote: string;
  errorMessage: string | null;
};

export type AddAssetAudioMode = "vocals" | "full_mix" | "none";

export type AddAssetContinuityMode = AddAssetGenerationMode;

export type { AddAssetBlueModel };

export function resolveAddAssetAudioMode(lyricsText: string): AddAssetAudioMode {
  return lyricsText.trim() ? "vocals" : "full_mix";
}

/** Shown in the generate modal when this section has no aligned lyrics. */
export const ADD_ASSET_NO_LYRICS_AUDIO_NOTE =
  "No lyrics in this section — the full mix will be used for audio.";

export const ADD_ASSET_FIRST_LAST_AUDIO_NOTE =
  "First–last frame generation does not use audio — the song stays on the timeline.";

export const ADD_ASSET_WAN_AUDIO_NOTE =
  "WAN has no audio processing — source audio is locked to None. The song stays on the timeline.";

export const ADD_ASSET_IMAGES_NONE_AUDIO_NOTE =
  "Text-to-video does not use source audio — source audio is locked to None. The song stays on the timeline.";

export function createRunningAddAssetGenerationSession(
  clipId: string,
  audioMode: AddAssetAudioMode,
  durationSec: number = ADD_ASSET_TIMELINE_DURATION_SEC,
  continuityMode: AddAssetContinuityMode = "start_frame",
): AddAssetGenerationSession {
  return {
    clipId,
    phase: "running",
    startedAtMs: Date.now(),
    expectedMs: addAssetGenerationExpectedMs(durationSec),
    steps: initialAddAssetGenerationSteps(audioMode, continuityMode),
    progressNote: "Starting…",
    errorMessage: null,
  };
}

export function initialAddAssetGenerationSteps(
  audioMode: AddAssetAudioMode = "vocals",
  continuityMode: AddAssetContinuityMode = "start_frame",
): AddAssetGenerationStep[] {
  if (continuityMode === "none") {
    return [
      { id: "generate", label: "Generate video", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  if (continuityMode === "motion_match") {
    return [
      { id: "still", label: "Prepare character still", status: "pending" },
      { id: "end-still", label: "Prepare motion reference", status: "pending" },
      { id: "generate", label: "Generate video", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  if (continuityMode === "first_last") {
    return [
      { id: "still", label: "Prepare first frame still", status: "pending" },
      { id: "end-still", label: "Prepare last frame still", status: "pending" },
      { id: "generate", label: "Generate video", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  if (audioMode === "none") {
    return [
      { id: "still", label: "Prepare framed start still", status: "pending" },
      { id: "generate", label: "Generate video", status: "pending" },
      { id: "file", label: "Add to project", status: "pending" },
    ];
  }
  const fullMix = audioMode === "full_mix";
  return [
    {
      id: "vocals",
      label: fullMix ? "Prepare audio slice" : "Prepare vocals slice",
      status: "pending",
    },
    {
      id: "upload-audio",
      label: fullMix ? "Upload audio clip" : "Upload vocals clip",
      status: "pending",
    },
    { id: "still", label: "Prepare framed start still", status: "pending" },
    { id: "generate", label: "Generate video", status: "pending" },
    { id: "file", label: "Add to project", status: "pending" },
  ];
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

/** Exact text passed to the A2V / flf2v `prompt` argument. */
export function buildAddAssetGenerationPrompt(prompt: string): string {
  return prompt.trim();
}

function formatClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function framingFilenameLabel(
  framing: StartFramePreview["framing"],
): "fill" | "stretch" | "fit" {
  if (framing === "fill") return "fill";
  if (framing === "stretch") return "stretch";
  return "fit";
}

async function uploadFramedStill(opts: {
  framePath: string;
  framing: StartFramePreview["framing"];
  aspectRatio: string;
  filenamePrefix: string;
  progressLabel: string;
  onProgress: (note: string) => void;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
}): Promise<{
  imageUrl: string;
  creationId: string;
  groupId: string | null;
  projectCreationIds: string[];
}> {
  const framingLabel = framingFilenameLabel(opts.framing);
  const uploaded = await uploadLocalImageFile(opts.framePath, {
    filename: `${opts.filenamePrefix}-${framingLabel}.jpg`,
    contentType: "image/jpeg",
  });
  opts.onProgress(`Creating ${opts.progressLabel} on Parascene…`);
  const result = await runLabParasceneGenerate({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    serverId: 1,
    method: "uploadImage",
    args: {
      image_url: uploaded.url,
      aspect_ratio: opts.aspectRatio,
    },
    mediaType: "image",
    intent: "text_to_image",
    label: "uploadImage",
    onProgress: opts.onProgress,
  });
  const [stillRow] = await getCreations([result.creationId]);
  const imageUrl = stillRow?.remoteUrl?.trim() || uploaded.url;
  if (!imageUrl) {
    throw new Error(`${opts.progressLabel} has no remote URL.`);
  }
  return {
    imageUrl,
    creationId: result.creationId,
    groupId: result.imagesGroupId,
    projectCreationIds: result.projectCreationIds,
  };
}

async function prepareParasceneGenerationStill(opts: {
  frame: StartFramePreview;
  aspectRatio: string;
  filenamePrefix: string;
  progressLabel: string;
  onProgress: (note: string) => void;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
}): Promise<{
  imageUrl: string;
  /** Parascene still Creation id the model will see (never a temp local-*). */
  creationId: string | null;
  projectCreationIds: string[];
  groupId: string | null;
}> {
  const passthrough = await resolveParasceneStartFrameImageUrl(opts.frame);
  if (passthrough) {
    opts.onProgress(`Using ${opts.progressLabel} on Parascene…`);
    const existingId =
      opts.frame.sourceIsImage && opts.frame.sourceAssetId?.trim()
        ? opts.frame.sourceAssetId.trim()
        : null;
    if (!existingId) {
      // URL-only passthrough (rare) — no flat project member, no Creation id.
      return {
        imageUrl: passthrough,
        creationId: null,
        projectCreationIds: [],
        groupId: null,
      };
    }
    // Already a Parascene Creation: keep it in the Images group only — never
    // also file it as a flat project folder member.
    opts.onProgress(`Filing ${opts.progressLabel} into Images group…`);
    const filed = await fileCreationIntoProjectGroup({
      creationId: existingId,
      mediaType: "image",
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
    });
    return {
      imageUrl: passthrough,
      creationId: existingId,
      projectCreationIds: filed.projectCreationIds,
      groupId: filed.groupId,
    };
  }
  if (!opts.frame.framePath?.trim()) {
    throw new Error(
      `Missing ${opts.progressLabel} — choose an image from Assets or place the clip next to timeline media.`,
    );
  }
  opts.onProgress(`Preparing framed ${opts.progressLabel}…`);
  const still = await uploadFramedStill({
    framePath: opts.frame.framePath,
    framing: opts.frame.framing,
    aspectRatio: opts.aspectRatio,
    filenamePrefix: opts.filenamePrefix,
    progressLabel: opts.progressLabel,
    onProgress: opts.onProgress,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  return {
    imageUrl: still.imageUrl,
    creationId: still.creationId,
    projectCreationIds: still.projectCreationIds,
    groupId: still.groupId,
  };
}

export type ReplaceAddAssetPlaceholderMeta = {
  addAssetGeneration: AddAssetGeneration;
};

/**
 * Sync-to-timeline only when generation consumed timeline song audio
 * (vocals / full mix). Start-frame / bridge continuity alone does not lock.
 */
export function generatedClipShouldSyncToTimeline(
  generation: AddAssetGeneration | null | undefined,
): boolean {
  if (!generation) return false;
  const server =
    generation.server?.trim() || generation.provider?.trim() || "";
  // Replicate fills do not use the timeline song as generation audio.
  if (server === "replicate") return false;
  return (
    generation.audioMode === "vocals" || generation.audioMode === "full_mix"
  );
}

/** Swap a placeholder for a generated video without disturbing other timeline edits. */
export function replaceAddAssetPlaceholderWithVideo(
  timeline: readonly TimelineClip[],
  clipId: string,
  creationId: string,
  meta?: ReplaceAddAssetPlaceholderMeta,
): TimelineClip[] {
  return timeline.map((clip) => {
    if (clip.id !== clipId) return clip;
    const duration = addAssetClipDurationSec(clip);
    const syncToTimeline = generatedClipShouldSyncToTimeline(
      meta?.addAssetGeneration,
    );
    return {
      ...clip,
      assetId: creationId,
      kind: "video",
      label: formatClipDuration(duration),
      inSec: 0,
      outSec: duration,
      endSec: clip.startSec + duration,
      includeAudio: false,
      isAddAssetPlaceholder: undefined,
      timelineLocked: syncToTimeline ? true : undefined,
      addAssetDraft: undefined,
      addAssetGeneration: meta?.addAssetGeneration,
      thumbUrl: null,
    };
  });
}

/**
 * Find generation provenance for an Assets-pane creation id by scanning timeline
 * clips. Prefer {@link resolveAddAssetGenerationFromCreation} on the catalog row
 * when present — desktop stamps survive clip deletion, and Parascene `meta.args`
 * fills in when no stamp was written.
 */
export function findTimelineGenerationForAsset(
  timeline: readonly TimelineClip[],
  assetId: string | null | undefined,
): { clip: TimelineClip; generation: AddAssetGeneration } | null {
  const id = assetId?.trim();
  if (!id) return null;
  for (const clip of timeline) {
    const generation = clip.addAssetGeneration;
    if (!generation) continue;
    const creationId = generation.creationId?.trim();
    const clipAssetId = clip.assetId?.trim();
    if (creationId === id || clipAssetId === id) {
      return { clip, generation };
    }
  }
  return null;
}

export type RunAddAssetGenerationOpts = {
  placeholder: TimelineClip;
  timeline: readonly TimelineClip[];
  mainAudioCreationId: string | null;
  lyricAlignment?: LyricAlignment | null;
  aspectRatio: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  continuityMode?: AddAssetContinuityMode;
  /** Parascene Blue model; ignored for Replicate runs. */
  blueModel?: AddAssetBlueModel;
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
  /** When set, run via Replicate instead of Parascene Blue. */
  replicate?: {
    owner: string;
    name: string;
    inputs: ReplicateInputField[];
    useNearestDuration?: boolean;
    motionVideoPath?: string | null;
    characterFrame?: StartFramePreview | null;
    tweaks?: import("./replicateVideoTweaks").ReplicateVideoTweaks;
  };
  /** When true, run via Direct to Blue (local-only import). */
  blueDirect?: boolean;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
  /** Persist remote job ids for app-restart resume. */
  onRemoteJob?: (job: {
    provider: "replicate" | "parascene_blue" | "blue_direct";
    replicatePredictionId?: string;
    pendingCreationId?: string;
    blueJobId?: string;
    /** Durable service_invoke job id (survives remount / restart). */
    serviceJobId?: string;
    model?: string;
  }) => void;
};

export async function runAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  /** Parascene still Creation used as FIRST (never a temp local-* extract). */
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  const resolvedIntent =
    resolveAddAssetIntent(opts.placeholder.addAssetDraft ?? {})?.intentId ??
    "image_to_video";
  if (
    !opts.replicate &&
    !opts.blueDirect &&
    (resolvedIntent === "video_to_video" ||
      resolvedIntent === "reference_to_video")
  ) {
    return runParasceneProductVideoIntent({
      ...opts,
      intentId: resolvedIntent,
    });
  }
  if (opts.replicate) {
    const continuityMode = (opts.continuityMode ??
      "start_frame") as ReplicateVideoContinuity;
    return runReplicateAddAssetGeneration({
      placeholder: opts.placeholder,
      timeline: opts.timeline,
      aspectRatio: opts.aspectRatio,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      prompt: opts.prompt,
      continuityMode,
      modelOwner: opts.replicate.owner,
      modelName: opts.replicate.name,
      modelInputs: opts.replicate.inputs,
      durationSec: addAssetClipDurationSec(opts.placeholder),
      useNearestDuration: opts.replicate.useNearestDuration,
      startFrame: opts.startFrame,
      endFrame: opts.endFrame,
      characterFrame: opts.replicate.characterFrame,
      motionVideoPath: opts.replicate.motionVideoPath,
      tweaks: opts.replicate.tweaks,
      onSteps: opts.onSteps,
      onProgress: opts.onProgress,
      onPredictionId: (predictionId) => {
        opts.onRemoteJob?.({
          provider: "replicate",
          replicatePredictionId: predictionId,
          model: `${opts.replicate!.owner}/${opts.replicate!.name}`,
        });
      },
      onServiceJobId: (jobId) => {
        opts.onRemoteJob?.({
          provider: "replicate",
          serviceJobId: jobId,
          model: `${opts.replicate!.owner}/${opts.replicate!.name}`,
        });
      },
    });
  }
  if (opts.blueDirect) {
    return runBlueDirectAddAssetGeneration({
      placeholder: opts.placeholder,
      timeline: opts.timeline,
      aspectRatio: opts.aspectRatio,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      mainAudioCreationId: opts.mainAudioCreationId,
      lyricAlignment: opts.lyricAlignment ?? null,
      prompt: opts.prompt,
      audioMode: opts.audioMode,
      continuityMode: opts.continuityMode ?? "start_frame",
      blueModel: opts.blueModel,
      startFrame: opts.startFrame,
      endFrame: opts.endFrame,
      onSteps: opts.onSteps,
      onProgress: opts.onProgress,
      onBlueJobId: (jobId) => {
        opts.onRemoteJob?.({
          provider: "blue_direct",
          blueJobId: jobId,
          model: opts.blueModel?.trim() || "blue",
        });
      },
      onServiceJobId: (jobId) => {
        opts.onRemoteJob?.({
          provider: "blue_direct",
          serviceJobId: jobId,
          model: opts.blueModel?.trim() || "blue",
        });
      },
    });
  }
  const continuityMode = opts.continuityMode ?? "start_frame";
  if (continuityMode === "motion_match") {
    throw new Error("Motion match requires a Replicate model.");
  }
  if (continuityMode === "none") {
    return runTextToVideoAddAssetGeneration(opts);
  }
  if (continuityMode === "first_last") {
    return runFirstLastAddAssetGeneration(opts);
  }
  return runStartFrameAddAssetGeneration(opts);
}

async function runParasceneProductVideoIntent(
  opts: RunAddAssetGenerationOpts & {
    intentId: Extract<GenerateIntentId, "video_to_video" | "reference_to_video">;
  },
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
  const model = opts.blueModel?.trim();
  if (!model) {
    throw new Error("Choose a Parascene video model.");
  }
  const result = await runParasceneProductVideoGeneration({
    intentId: opts.intentId,
    placeholder: opts.placeholder,
    timeline: opts.timeline,
    aspectRatio: opts.aspectRatio,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    mainAudioCreationId: opts.mainAudioCreationId,
    lyricAlignment: opts.lyricAlignment,
    prompt: opts.prompt,
    model,
    startFrame: opts.startFrame,
    inputVideoCreationId:
      opts.intentId === "video_to_video"
        ? opts.startFrame.sourceAssetId ??
          opts.placeholder.addAssetDraft?.startFrameAssetId
        : undefined,
    referenceCreationIds:
      opts.intentId === "reference_to_video" && opts.startFrame.sourceAssetId
        ? [opts.startFrame.sourceAssetId]
        : undefined,
    onProgress: opts.onProgress,
    onPendingCreation: (id) => {
      if (id) {
        opts.onRemoteJob?.({
          provider: "parascene_blue",
          pendingCreationId: id,
          model,
        });
      }
    },
    onServiceJobId: (id) => {
      opts.onRemoteJob?.({
        provider: "parascene_blue",
        serviceJobId: id,
        model,
      });
    },
  });
  return {
    creationId: result.creationId,
    projectCreationIds: result.projectCreationIds,
    videosGroupId: result.videosGroupId,
    imagesGroupId: result.imagesGroupId,
    startFrameCreationId: null,
    endFrameCreationId: null,
    mode: "start_frame",
    model: result.model,
  };
}

async function runParasceneVideoViaService(opts: {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  placeholderId: string;
  method: string;
  args: Record<string, unknown>;
  intent: string;
  model: string;
  onProgress: (note: string) => void;
  onRemoteJob?: RunAddAssetGenerationOpts["onRemoteJob"];
}): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
}> {
  opts.onProgress(
    opts.intent === "text_to_video"
      ? "Starting text-to-video…"
      : "Starting image-to-video…",
  );
  const handle = await invokeParasceneGenerate({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    serverId: 6,
    method: opts.method,
    args: opts.args,
    intent: opts.intent,
    mediaType: "video",
    target: "timeline",
    clientRequestId: opts.placeholderId,
    label: opts.model,
  });
  if (handle.mode === "job") {
    opts.onRemoteJob?.({
      provider: "parascene_blue",
      serviceJobId: handle.id,
      model: opts.model,
    });
  }
  const result = await watchParasceneGenerate(handle, {
    onUpdate: (run: ServiceRun) => {
      const note = run.progressNote?.trim();
      if (note) opts.onProgress(note);
      const pendingId = pendingCreationIdFromRun(run);
      if (pendingId) {
        opts.onRemoteJob?.({
          provider: "parascene_blue",
          pendingCreationId: pendingId,
          serviceJobId: handle.mode === "job" ? handle.id : undefined,
          model: opts.model,
        });
      }
    },
  });
  return {
    creationId: result.creationId,
    projectCreationIds: result.projectCreationIds,
    videosGroupId: result.videosGroupId ?? opts.videosGroupId,
    imagesGroupId: result.imagesGroupId ?? opts.imagesGroupId,
  };
}

async function runTextToVideoAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
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
  let steps = initialAddAssetGenerationSteps("none", "none");
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);
  if (!fullPrompt.trim()) {
    throw new Error("Enter a prompt for text-to-video.");
  }

  const { durationSec: durationSeconds } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    opts.mainAudioCreationId,
    opts.lyricAlignment,
  );

  const model =
    isWanFamilyBlueModel(opts.blueModel ?? "")
      ? WAN_T2V_MODEL
      : LTX_T2V_MODEL;

  pushSteps(advanceStep(steps, "generate"));
  const args = buildBlueT2vCreateArgs({
    prompt: fullPrompt,
    aspectRatio: opts.aspectRatio,
    model,
    durationSeconds,
  });
  const result = await runParasceneVideoViaService({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    placeholderId: opts.placeholder.id,
    method: "text2video",
    args,
    intent: "text_to_video",
    model,
    onProgress: opts.onProgress,
    onRemoteJob: opts.onRemoteJob,
  });
  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));

  return {
    creationId: result.creationId,
    projectCreationIds: result.projectCreationIds,
    videosGroupId: result.videosGroupId,
    imagesGroupId: result.imagesGroupId,
    startFrameCreationId: null,
    endFrameCreationId: null,
    mode: "none",
    model,
  };
}

async function runFirstLastAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  /** Durable Parascene still Creation used as FIRST (not a temp local extract). */
  startFrameCreationId: string | null;
  endFrameCreationId: string | null;
  mode: AddAssetContinuityMode;
  model: string;
}> {
  let steps = initialAddAssetGenerationSteps(opts.audioMode, "first_last");
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const { durationSec: durationSeconds } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    opts.mainAudioCreationId,
    opts.lyricAlignment,
  );

  if (!startFrameIsReady(opts.startFrame)) {
    throw new Error(
      "Place this clip after another clip on the timeline, or choose an image from assets.",
    );
  }
  if (!opts.endFrame || !startFrameIsReady(opts.endFrame)) {
    throw new Error(
      "Place this clip before another clip on the timeline for first–last generation.",
    );
  }

  pushSteps(advanceStep(steps, "still"));
  const firstStill = await prepareParasceneGenerationStill({
    frame: opts.startFrame,
    aspectRatio: opts.aspectRatio,
    filenamePrefix: "editor-flf2v-first",
    progressLabel: "first frame",
    onProgress: opts.onProgress,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  pushSteps(completeStep(steps, "still"));

  pushSteps(advanceStep(steps, "end-still"));
  const lastStill = await prepareParasceneGenerationStill({
    frame: opts.endFrame,
    aspectRatio: opts.aspectRatio,
    filenamePrefix: "editor-flf2v-last",
    progressLabel: "last frame",
    onProgress: opts.onProgress,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: firstStill.groupId ?? opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  pushSteps(completeStep(steps, "end-still"));

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);

  pushSteps(advanceStep(steps, "generate"));
  const args = buildFlf2vCreateArgs({
    prompt: fullPrompt,
    aspectRatio: opts.aspectRatio,
    firstImageUrl: firstStill.imageUrl,
    lastImageUrl: lastStill.imageUrl,
    durationSeconds,
  });
  const result = await runParasceneVideoViaService({
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: lastStill.groupId ?? firstStill.groupId ?? opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    placeholderId: opts.placeholder.id,
    method: "image2video",
    args: args as unknown as Record<string, unknown>,
    intent: "image_to_video",
    model: FLF2V_MODEL,
    onProgress: opts.onProgress,
    onRemoteJob: opts.onRemoteJob,
  });
  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));

  return {
    creationId: result.creationId,
    projectCreationIds: [
      ...new Set([
        ...firstStill.projectCreationIds,
        ...lastStill.projectCreationIds,
        ...result.projectCreationIds,
      ]),
    ],
    videosGroupId: result.videosGroupId,
    imagesGroupId: lastStill.groupId ?? firstStill.groupId ?? result.imagesGroupId,
    startFrameCreationId: firstStill.creationId,
    endFrameCreationId: lastStill.creationId,
    mode: "first_last",
    model: FLF2V_MODEL,
  };
}

async function runStartFrameAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
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
  const audioMode = opts.audioMode;
  let steps = initialAddAssetGenerationSteps(audioMode, "start_frame");
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const { durationSec: durationSeconds, songRange } =
    resolveAddAssetGenerationTiming(
      opts.timeline,
      opts.placeholder,
      opts.mainAudioCreationId,
      opts.lyricAlignment,
    );
  const inSec = songRange.startSec;
  const sliceOutSec = inSec + durationSeconds;
  if (!(sliceOutSec > inSec)) {
    throw new Error("Invalid song time range for this clip.");
  }

  let audioClipId: string | null = null;
  if (audioMode !== "none") {
    const audioId = opts.mainAudioCreationId?.trim();
    if (!audioId) {
      throw new Error(
        "Add main audio to the timeline (or set it in Lab) before generating.",
      );
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
    opts.onProgress("Uploading audio clip…");
    const { clipId } = await uploadVocalsSliceClip(audioSlice.path, {
      title:
        audioMode === "full_mix"
          ? `Editor mix ${inSec.toFixed(1)}–${sliceOutSec.toFixed(1)}s`
          : `Editor vocals ${inSec.toFixed(1)}–${sliceOutSec.toFixed(1)}s`,
      durationSec: durationSeconds,
    });
    audioClipId = clipId;
    pushSteps(completeStep(steps, "upload-audio"));
  }

  pushSteps(advanceStep(steps, "still"));
  let stillProjectCreationIds: string[] = [];
  let imagesGroupId = opts.imagesGroupId;

  const startStill = await prepareParasceneGenerationStill({
    frame: opts.startFrame,
    aspectRatio: opts.aspectRatio,
    filenamePrefix:
      opts.blueModel === "wan" || opts.blueModel === "wan_i2v"
        ? "editor-wan-i2v-start"
        : audioMode === "none"
          ? "editor-ltx-i2v-start"
          : "editor-a2v-start",
    progressLabel: "start image",
    onProgress: opts.onProgress,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  const imageUrl = startStill.imageUrl;
  stillProjectCreationIds = startStill.projectCreationIds;
  imagesGroupId = startStill.groupId ?? opts.imagesGroupId;
  pushSteps(completeStep(steps, "still"));

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);
  const useWan = isWanFamilyBlueModel(opts.blueModel ?? "");

  pushSteps(advanceStep(steps, "generate"));
  let creationId: string;
  let model: string;
  let filedProjectCreationIds: string[] = [];
  let videosGroupId: string | null = opts.videosGroupId;
  if (audioMode === "none" || !audioClipId) {
    model = useWan ? FLF2V_MODEL : LTX_I2V_MODEL;
    const args = useWan
      ? (buildFlf2vCreateArgs({
          prompt: fullPrompt,
          aspectRatio: opts.aspectRatio,
          firstImageUrl: imageUrl,
          durationSeconds,
        }) as unknown as Record<string, unknown>)
      : (buildLtxI2vCreateArgs({
          prompt: fullPrompt,
          aspectRatio: opts.aspectRatio,
          imageUrl,
          durationSeconds,
        }) as unknown as Record<string, unknown>);
    const result = await runParasceneVideoViaService({
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: imagesGroupId ?? opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      placeholderId: opts.placeholder.id,
      method: "image2video",
      args,
      intent: "image_to_video",
      model,
      onProgress: opts.onProgress,
      onRemoteJob: opts.onRemoteJob,
    });
    creationId = result.creationId;
    filedProjectCreationIds = result.projectCreationIds;
    videosGroupId = result.videosGroupId;
    imagesGroupId = result.imagesGroupId ?? imagesGroupId;
  } else {
    if (useWan) {
      throw new Error("WAN has no audio processing — choose Source audio None.");
    }
    model = "ltx_a2v";
    const args: Record<string, unknown> = {
      prompt: fullPrompt.trim(),
      model,
      aspect_ratio: opts.aspectRatio,
      input_images: [imageUrl],
      audio_clip_id: Number(audioClipId),
    };
    if (
      typeof durationSeconds === "number" &&
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0
    ) {
      args.duration_seconds = durationSeconds;
    }
    const result = await runParasceneVideoViaService({
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      imagesGroupId: imagesGroupId ?? opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      placeholderId: opts.placeholder.id,
      method: "audio2video",
      args,
      intent: "image_to_video",
      model,
      onProgress: opts.onProgress,
      onRemoteJob: opts.onRemoteJob,
    });
    creationId = result.creationId;
    filedProjectCreationIds = result.projectCreationIds;
    videosGroupId = result.videosGroupId;
    imagesGroupId = result.imagesGroupId ?? imagesGroupId;
  }
  pushSteps(completeStep(steps, "generate"));
  pushSteps(advanceStep(steps, "file"));
  pushSteps(completeStep(steps, "file"));

  return {
    creationId,
    projectCreationIds: [
      ...new Set([...stillProjectCreationIds, ...filedProjectCreationIds]),
    ],
    videosGroupId,
    imagesGroupId,
    startFrameCreationId: startStill.creationId,
    endFrameCreationId: null,
    mode: "start_frame",
    model,
  };
}
