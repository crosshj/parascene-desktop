import {
  isolateVocalsRange,
  uploadLocalImageFile,
  sliceAudioRange,
  uploadVocalsSliceClip,
} from "../../lab/audioTools";
import { runA2vGeneration } from "../../lab/a2vGeneration";
import { fileCreationIntoProjectGroup } from "../../lab/projectGroups";
import { getCreations } from "../../library/catalogClient";
import type { AddAssetGeneration, TimelineClip } from "../../project/types";
import type { StartFramePreview } from "./addAssetStartFrame";
import { ADD_ASSET_TIMELINE_DURATION_SEC } from "./stagedClip";

export type AddAssetGenerationStepId =
  | "vocals"
  | "upload-audio"
  | "still"
  | "generate"
  | "file";

export type AddAssetGenerationStep = {
  id: AddAssetGenerationStepId;
  label: string;
  status: "pending" | "active" | "done";
};

/** Typical A2V turnaround — progress bar fills over this duration, then cycles. */
export const ADD_ASSET_GENERATION_EXPECTED_MS = 150_000;

export type AddAssetGenerationProgress = {
  percent: number;
  indeterminate: boolean;
};

export function addAssetGenerationProgress(
  elapsedMs: number,
  expectedMs: number = ADD_ASSET_GENERATION_EXPECTED_MS,
): AddAssetGenerationProgress {
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed >= expectedMs) {
    return { percent: 100, indeterminate: true };
  }
  return {
    percent: Math.min(100, (elapsed / expectedMs) * 100),
    indeterminate: false,
  };
}

/** Background generation tracked while the modal may be closed. */
export type AddAssetGenerationSession = {
  clipId: string;
  phase: "running" | "error";
  startedAtMs: number;
  steps: AddAssetGenerationStep[];
  progressNote: string;
  errorMessage: string | null;
};

export type AddAssetAudioMode = "vocals" | "full_mix";

export function resolveAddAssetAudioMode(lyricsText: string): AddAssetAudioMode {
  return lyricsText.trim() ? "vocals" : "full_mix";
}

/** Shown in the generate modal when this section has no aligned lyrics. */
export const ADD_ASSET_NO_LYRICS_AUDIO_NOTE =
  "No lyrics in this section — the full mix will be used for audio.";

export function createRunningAddAssetGenerationSession(
  clipId: string,
  audioMode: AddAssetAudioMode,
): AddAssetGenerationSession {
  return {
    clipId,
    phase: "running",
    startedAtMs: Date.now(),
    steps: initialAddAssetGenerationSteps(audioMode),
    progressNote: "Starting…",
    errorMessage: null,
  };
}

export function initialAddAssetGenerationSteps(
  audioMode: AddAssetAudioMode = "vocals",
): AddAssetGenerationStep[] {
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
    { id: "still", label: "Prepare start frame", status: "pending" },
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
  const order = initialAddAssetGenerationSteps().map((s) => s.id);
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

/** Exact text passed to the A2V `prompt` argument. */
export function buildAddAssetGenerationPrompt(prompt: string): string {
  return prompt.trim();
}

function formatClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type ReplaceAddAssetPlaceholderMeta = {
  addAssetGeneration: AddAssetGeneration;
};

/** Swap a placeholder for a generated video without disturbing other timeline edits. */
export function replaceAddAssetPlaceholderWithVideo(
  timeline: readonly TimelineClip[],
  clipId: string,
  creationId: string,
  meta?: ReplaceAddAssetPlaceholderMeta,
): TimelineClip[] {
  return timeline.map((clip) => {
    if (clip.id !== clipId) return clip;
    const duration = Math.max(
      0.1,
      clip.endSec - clip.startSec || ADD_ASSET_TIMELINE_DURATION_SEC,
    );
    return {
      ...clip,
      assetId: creationId,
      kind: "video",
      label: formatClipDuration(duration),
      inSec: 0,
      outSec: duration,
      includeAudio: false,
      isAddAssetPlaceholder: undefined,
      timelineLocked: true,
      addAssetGeneration: meta?.addAssetGeneration,
      thumbUrl: null,
    };
  });
}

export type RunAddAssetGenerationOpts = {
  placeholder: TimelineClip;
  mainAudioCreationId: string | null;
  aspectRatio: string;
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  songRange: { startSec: number; endSec: number };
  startFrame: StartFramePreview;
  onSteps: (steps: AddAssetGenerationStep[]) => void;
  onProgress: (note: string) => void;
};

export async function runAddAssetGeneration(
  opts: RunAddAssetGenerationOpts,
): Promise<{
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
}> {
  const audioMode = opts.audioMode;
  let steps = initialAddAssetGenerationSteps(audioMode);
  const pushSteps = (next: AddAssetGenerationStep[]) => {
    steps = next;
    opts.onSteps(steps);
  };

  const inSec = opts.songRange.startSec;
  const outSec = opts.songRange.endSec;
  if (!(outSec > inSec)) {
    throw new Error("Invalid song time range for this clip.");
  }
  const audioId = opts.mainAudioCreationId?.trim();
  if (!audioId) {
    throw new Error("Set the project main audio in Lab before generating.");
  }

  pushSteps(advanceStep(steps, "vocals"));
  opts.onProgress(
    audioMode === "full_mix"
      ? "Preparing audio slice…"
      : "Preparing vocals stem…",
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
          outSec,
        })
      : await isolateVocalsRange({
          sourcePath: mixPath,
          inSec,
          outSec,
        });
  pushSteps(completeStep(steps, "vocals"));

  pushSteps(advanceStep(steps, "upload-audio"));
  opts.onProgress("Uploading audio clip…");
  const { clipId } = await uploadVocalsSliceClip(audioSlice.path, {
    title:
      audioMode === "full_mix"
        ? `Editor mix ${inSec.toFixed(1)}–${outSec.toFixed(1)}s`
        : `Editor vocals ${inSec.toFixed(1)}–${outSec.toFixed(1)}s`,
    durationSec: outSec - inSec,
  });
  pushSteps(completeStep(steps, "upload-audio"));

  pushSteps(advanceStep(steps, "still"));
  opts.onProgress("Preparing start frame…");
  if (!opts.startFrame.framePath?.trim()) {
    throw new Error(
      "Place this clip after another clip on the timeline.",
    );
  }
  const uploaded = await uploadLocalImageFile(opts.startFrame.framePath, {
    filename: "editor-a2v-start-frame.jpg",
    contentType: "image/jpeg",
  });
  const imageUrl = uploaded.url;
  pushSteps(completeStep(steps, "still"));

  const fullPrompt = buildAddAssetGenerationPrompt(opts.prompt);

  pushSteps(advanceStep(steps, "generate"));
  const { creationId } = await runA2vGeneration({
    prompt: fullPrompt,
    aspectRatio: opts.aspectRatio,
    imageUrl,
    audioClipId: clipId,
    onProgress: opts.onProgress,
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
  };
}
