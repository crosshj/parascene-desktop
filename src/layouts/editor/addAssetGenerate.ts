import {
  isolateVocalsRange,
  uploadLocalImageFile,
  sliceAudioRange,
  uploadVocalsSliceClip,
} from "../../lab/audioTools";
import { runA2vGeneration } from "../../lab/a2vGeneration";
import {
  LTX_T2V_MODEL,
  runBlueT2vGeneration,
  WAN_T2V_MODEL,
} from "../../lab/blueT2vGeneration";
import { FLF2V_MODEL, runFlf2vGeneration } from "../../lab/flf2vGeneration";
import { LTX_I2V_MODEL, runLtxI2vGeneration } from "../../lab/ltxI2vGeneration";
import { createAuthedSdk } from "../../auth/session";
import { ingestRemoteCreation, newCreationToken } from "../../lab/ingestCreation";
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
  ADD_ASSET_TIMELINE_DURATION_SEC,
  addAssetClipDurationSec,
  clampAddAssetDurationSec,
} from "./stagedClip";
import { resolveAddAssetGenerationTiming } from "./addAssetStartFrame";
import type { StartFramePreview } from "./addAssetStartFrame";
import { runReplicateAddAssetGeneration } from "./addAssetReplicateGenerate";
import { runBlueDirectAddAssetGeneration } from "./addAssetBlueDirectGenerate";
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
  const sdk = createAuthedSdk();
  const startedStill = await sdk.create({
    serverId: 1,
    method: "uploadImage",
    creationToken: newCreationToken(),
    args: {
      image_url: uploaded.url,
      aspect_ratio: opts.aspectRatio,
    },
  });
  opts.onProgress(`Waiting for ${opts.progressLabel} ${startedStill.id}…`);
  const doneStill = await sdk.waitForCreation(startedStill.id, {
    onTick: (row) =>
      opts.onProgress(
        `Waiting for ${opts.progressLabel} (${row.status || "…"})…`,
      ),
  });
  if (String(doneStill.status).toLowerCase() === "failed") {
    throw new Error(
      `${opts.progressLabel} upload failed (${doneStill.id})`,
    );
  }
  const stillCreationId = await ingestRemoteCreation(doneStill);
  opts.onProgress(`Filing ${opts.progressLabel} into Images group…`);
  const filedStill = await fileCreationIntoProjectGroup({
    creationId: stillCreationId,
    mediaType: "image",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  const [stillRow] = await getCreations([stillCreationId]);
  const imageUrl = stillRow?.remoteUrl?.trim() || uploaded.url;
  if (!imageUrl) {
    throw new Error(`${opts.progressLabel} has no remote URL.`);
  }
  return {
    imageUrl,
    creationId: stillCreationId,
    groupId: filedStill.groupId,
    projectCreationIds: filedStill.projectCreationIds,
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
 * clips. Prefer {@link addAssetGenerationFromCreation} on the catalog row when
 * present — that stamp survives clip deletion.
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
  mode: AddAssetContinuityMode;
  model: string;
}> {
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

async function runTextToVideoAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
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
  const { creationId } = await runBlueT2vGeneration({
    prompt: fullPrompt,
    aspectRatio: opts.aspectRatio,
    model,
    durationSeconds,
    onProgress: opts.onProgress,
    onPendingCreation: (id) => {
      if (!id) return;
      opts.onRemoteJob?.({
        provider: "parascene_blue",
        pendingCreationId: id,
        model,
      });
    },
  });
  pushSteps(completeStep(steps, "generate"));

  pushSteps(advanceStep(steps, "file"));
  opts.onProgress("Filing video into project…");
  const filed = await fileCreationIntoProjectGroup({
    creationId,
    mediaType: "video",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  pushSteps(completeStep(steps, "file"));

  return {
    creationId,
    projectCreationIds: filed.projectCreationIds,
    videosGroupId: filed.groupId,
    imagesGroupId: opts.imagesGroupId,
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

  if (!opts.startFrame.framePath?.trim()) {
    throw new Error(
      "Place this clip after another clip on the timeline.",
    );
  }
  if (!opts.endFrame?.framePath?.trim()) {
    throw new Error(
      "Place this clip before another clip on the timeline for first–last generation.",
    );
  }

  pushSteps(advanceStep(steps, "still"));
  opts.onProgress("Preparing framed first still…");
  const firstStill = await uploadFramedStill({
    framePath: opts.startFrame.framePath,
    framing: opts.startFrame.framing,
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
  opts.onProgress("Preparing framed last still…");
  const lastStill = await uploadFramedStill({
    framePath: opts.endFrame.framePath,
    framing: opts.endFrame.framing,
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
  const { creationId } = await runFlf2vGeneration({
    prompt: fullPrompt,
    aspectRatio: opts.aspectRatio,
    firstImageUrl: firstStill.imageUrl,
    lastImageUrl: lastStill.imageUrl,
    durationSeconds,
    onProgress: opts.onProgress,
    onPendingCreation: (id) => {
      if (!id) return;
      opts.onRemoteJob?.({
        provider: "parascene_blue",
        pendingCreationId: id,
        model: FLF2V_MODEL,
      });
    },
  });
  pushSteps(completeStep(steps, "generate"));

  pushSteps(advanceStep(steps, "file"));
  opts.onProgress("Filing video into project…");
  const filed = await fileCreationIntoProjectGroup({
    creationId,
    mediaType: "video",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: lastStill.groupId ?? firstStill.groupId ?? opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  pushSteps(completeStep(steps, "file"));

  return {
    creationId,
    projectCreationIds: [
      ...new Set([
        ...firstStill.projectCreationIds,
        ...lastStill.projectCreationIds,
        ...filed.projectCreationIds,
      ]),
    ],
    videosGroupId: filed.groupId,
    imagesGroupId: lastStill.groupId ?? firstStill.groupId,
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
  const existingImageUrl = opts.startFrame.remoteImageUrl?.trim();
  const sourceAssetId = opts.startFrame.sourceAssetId?.trim();
  let imageUrl: string;
  let stillProjectCreationIds: string[] = [];
  let imagesGroupId = opts.imagesGroupId;

  if (existingImageUrl && sourceAssetId) {
    opts.onProgress("Using project image on Parascene…");
    imageUrl = existingImageUrl;
    pushSteps(completeStep(steps, "still"));
  } else {
    opts.onProgress("Preparing framed start still…");
    if (!opts.startFrame.framePath?.trim()) {
      throw new Error(
        "Place this clip after another clip on the timeline, or choose an image from assets.",
      );
    }
    const startStill = await uploadFramedStill({
      framePath: opts.startFrame.framePath,
      framing: opts.startFrame.framing,
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
    imageUrl = startStill.imageUrl;
    stillProjectCreationIds = startStill.projectCreationIds;
    imagesGroupId = startStill.groupId ?? opts.imagesGroupId;
    pushSteps(completeStep(steps, "still"));
  }

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);
  const useWan = isWanFamilyBlueModel(opts.blueModel ?? "");

  pushSteps(advanceStep(steps, "generate"));
  let creationId: string;
  let model: string;
  const onPendingCreation = (id: string | null, nextModel: string) => {
    if (!id) return;
    opts.onRemoteJob?.({
      provider: "parascene_blue",
      pendingCreationId: id,
      model: nextModel,
    });
  };
  if (audioMode === "none" || !audioClipId) {
    if (useWan) {
      const result = await runFlf2vGeneration({
        prompt: fullPrompt,
        aspectRatio: opts.aspectRatio,
        firstImageUrl: imageUrl,
        durationSeconds,
        onProgress: opts.onProgress,
        onPendingCreation: (id) => onPendingCreation(id, FLF2V_MODEL),
      });
      creationId = result.creationId;
      model = FLF2V_MODEL;
    } else {
      const result = await runLtxI2vGeneration({
        prompt: fullPrompt,
        aspectRatio: opts.aspectRatio,
        imageUrl,
        durationSeconds,
        onProgress: opts.onProgress,
        onPendingCreation: (id) => onPendingCreation(id, LTX_I2V_MODEL),
      });
      creationId = result.creationId;
      model = LTX_I2V_MODEL;
    }
  } else {
    if (useWan) {
      throw new Error("WAN has no audio processing — choose Source audio None.");
    }
    const result = await runA2vGeneration({
      prompt: fullPrompt,
      aspectRatio: opts.aspectRatio,
      imageUrl,
      audioClipId,
      durationSeconds,
      onProgress: opts.onProgress,
      onPendingCreation: (id) => onPendingCreation(id, "ltx_a2v"),
    });
    creationId = result.creationId;
    model = "ltx_a2v";
  }
  pushSteps(completeStep(steps, "generate"));

  pushSteps(advanceStep(steps, "file"));
  opts.onProgress("Filing video into project…");
  const filed = await fileCreationIntoProjectGroup({
    creationId,
    mediaType: "video",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: imagesGroupId ?? opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
  });
  pushSteps(completeStep(steps, "file"));

  return {
    creationId,
    projectCreationIds: [
      ...new Set([...stillProjectCreationIds, ...filed.projectCreationIds]),
    ],
    videosGroupId: filed.groupId,
    imagesGroupId,
    mode: "start_frame",
    model,
  };
}
