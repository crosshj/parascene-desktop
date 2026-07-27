import { useSyncExternalStore } from "react";
import type { StartAddAssetGenerationRequest } from "./AddAssetGeneratePanel";
import {
  createRunningAddAssetGenerationSession,
  runAddAssetGeneration,
  type AddAssetAudioMode,
  type AddAssetContinuityMode,
  type AddAssetGenerationSession,
  type RunAddAssetGenerationOpts,
} from "./addAssetGenerate";
import {
  initialReplicateDownloadRetrySteps,
  initialReplicateGenerationSteps,
  ReplicatePendingDownloadError,
  resumeReplicateAddAssetDownload,
} from "./addAssetReplicateGenerate";
import { addAssetClipDurationSec } from "./stagedClip";
import type { ReplicateVideoContinuity } from "./replicateRunConstraints";

/**
 * Module-level add-asset generation session.
 * Survives EditorLayout unmount (e.g. switching to Library) so in-flight
 * jobs keep updating and can still write the finished clip into the project.
 */

export type AddAssetGenerationStoreSession = AddAssetGenerationSession & {
  projectId: string;
};

export type AddAssetGenerationSuccess = {
  projectId: string;
  clipId: string;
  creationId: string;
  projectCreationIds: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  mode: AddAssetContinuityMode;
  model: string;
};

export type AddAssetGenerationFailure = {
  projectId: string;
  clipId: string;
  errorMessage: string;
  /**
   * string = set, null = clear, undefined = leave existing draft value.
   * Set when Replicate succeeded and only download/import needs retry.
   */
  replicatePredictionId?: string | null;
};

export type AddAssetGenerationApplier = {
  applySuccess: (result: AddAssetGenerationSuccess) => void;
  /** Persist failure on the placeholder so the timeline ! survives navigation. */
  applyFailure: (result: AddAssetGenerationFailure) => void;
  /** Clear persisted failure when the user dismisses / retries. */
  clearFailure: (projectId: string, clipId: string) => void;
};

let session: AddAssetGenerationStoreSession | null = null;
let inflight = false;
let applier: AddAssetGenerationApplier | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setSession(next: AddAssetGenerationStoreSession | null): void {
  session = next;
  emit();
}

function patchSession(
  clipId: string,
  patch: Partial<AddAssetGenerationStoreSession>,
): void {
  if (!session || session.clipId !== clipId) return;
  session = { ...session, ...patch };
  emit();
}

export function getAddAssetGenerationSession(): AddAssetGenerationStoreSession | null {
  return session;
}

export function subscribeAddAssetGeneration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bindAddAssetGenerationApplier(
  next: AddAssetGenerationApplier | null,
): void {
  applier = next;
}

export function isAddAssetGenerationInflight(): boolean {
  return inflight;
}

export function clearAddAssetGenerationError(opts?: {
  projectId: string;
  clipId: string;
}): void {
  if (session?.phase === "error") {
    applier?.clearFailure(session.projectId, session.clipId);
    setSession(null);
    return;
  }
  if (opts?.projectId && opts.clipId) {
    applier?.clearFailure(opts.projectId, opts.clipId);
  }
}

/** Drop the session when its placeholder is no longer on the timeline. */
export function clearAddAssetGenerationIfClipMissing(
  timelineClipIds: ReadonlySet<string> | readonly string[],
): void {
  if (!session) return;
  const ids =
    timelineClipIds instanceof Set
      ? timelineClipIds
      : new Set(timelineClipIds);
  if (!ids.has(session.clipId)) {
    inflight = false;
    setSession(null);
  }
}

function applyJobFailure(
  projectId: string,
  clipId: string,
  audioMode: AddAssetAudioMode,
  durationSec: number,
  continuityMode: AddAssetContinuityMode,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  applier?.applyFailure({
    projectId,
    clipId,
    errorMessage: message,
    replicatePredictionId:
      error instanceof ReplicatePendingDownloadError
        ? error.predictionId
        : null,
  });
  if (session?.clipId === clipId) {
    patchSession(clipId, {
      phase: "error",
      progressNote: "Generation failed",
      errorMessage: message,
    });
  } else {
    setSession({
      ...createRunningAddAssetGenerationSession(
        clipId,
        audioMode,
        durationSec,
        continuityMode,
      ),
      projectId,
      phase: "error",
      progressNote: "Generation failed",
      errorMessage: message,
    });
  }
}

export type StartAddAssetGenerationJobOpts = {
  projectId: string;
  request: StartAddAssetGenerationRequest;
  runOpts: Omit<
    RunAddAssetGenerationOpts,
    "onSteps" | "onProgress" | "prompt" | "lyricsText" | "audioMode" | "continuityMode" | "startFrame" | "endFrame" | "placeholder"
  >;
};

/** Start (or no-op if already inflight). Returns false if a job is already running. */
export function startAddAssetGenerationJob(
  opts: StartAddAssetGenerationJobOpts,
): boolean {
  if (inflight) return false;
  const { projectId, request, runOpts } = opts;
  const clipId = request.clip.id;
  const continuityMode = request.continuityMode ?? "start_frame";
  inflight = true;
  const baseSession = createRunningAddAssetGenerationSession(
    clipId,
    request.audioMode,
    addAssetClipDurationSec(request.clip),
    continuityMode,
  );
  if (request.replicate) {
    baseSession.steps = initialReplicateGenerationSteps(
      continuityMode as ReplicateVideoContinuity,
    );
  }
  setSession({
    ...baseSession,
    projectId,
  });
  // Clear any prior persisted failure on this placeholder.
  applier?.clearFailure(projectId, clipId);

  void runAddAssetGeneration({
    ...runOpts,
    placeholder: request.clip,
    prompt: request.prompt,
    lyricsText: request.lyricsText,
    audioMode: request.audioMode,
    continuityMode,
    startFrame: request.startFrame,
    endFrame: request.endFrame,
    replicate: request.replicate,
    onSteps: (steps) => {
      patchSession(clipId, { steps });
    },
    onProgress: (progressNote) => {
      patchSession(clipId, { progressNote });
    },
  })
    .then((result) => {
      const success: AddAssetGenerationSuccess = {
        projectId,
        clipId,
        creationId: result.creationId,
        projectCreationIds: result.projectCreationIds,
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt: request.prompt,
        lyricsText: request.lyricsText,
        audioMode: request.audioMode,
        mode: result.mode,
        model: result.model,
      };
      applier?.applySuccess(success);
      // Only clear if this job is still the active session.
      if (session?.clipId === clipId) {
        setSession(null);
      }
    })
    .catch((error) => {
      applyJobFailure(
        projectId,
        clipId,
        request.audioMode,
        addAssetClipDurationSec(request.clip),
        continuityMode,
        error,
      );
    })
    .finally(() => {
      inflight = false;
    });

  return true;
}

export type RetryAddAssetDownloadJobOpts = {
  projectId: string;
  clipId: string;
  predictionId: string;
  imagesGroupId: string | null;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode;
  durationSec: number;
  modelId: string;
};

/** Retry download/import only for a prediction that already succeeded on Replicate. */
export function retryAddAssetDownloadJob(
  opts: RetryAddAssetDownloadJobOpts,
): boolean {
  if (inflight) return false;
  const {
    projectId,
    clipId,
    predictionId,
    imagesGroupId,
    prompt,
    lyricsText,
    audioMode,
    continuityMode,
    durationSec,
    modelId,
  } = opts;
  inflight = true;
  const baseSession = createRunningAddAssetGenerationSession(
    clipId,
    audioMode,
    durationSec,
    continuityMode,
  );
  baseSession.steps = initialReplicateDownloadRetrySteps();
  baseSession.progressNote = "Retrying download…";
  setSession({
    ...baseSession,
    projectId,
  });
  // Keep prediction id on the draft; clear only the error text while retrying.
  applier?.applyFailure({
    projectId,
    clipId,
    errorMessage: "",
    replicatePredictionId: predictionId,
  });

  void resumeReplicateAddAssetDownload({
    predictionId,
    imagesGroupId,
    continuityMode: continuityMode as ReplicateVideoContinuity,
    modelId,
    onSteps: (steps) => {
      patchSession(clipId, { steps });
    },
    onProgress: (progressNote) => {
      patchSession(clipId, { progressNote });
    },
  })
    .then((result) => {
      const success: AddAssetGenerationSuccess = {
        projectId,
        clipId,
        creationId: result.creationId,
        projectCreationIds: result.projectCreationIds,
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt,
        lyricsText,
        audioMode,
        mode: result.mode,
        model: result.model,
      };
      applier?.applySuccess(success);
      if (session?.clipId === clipId) {
        setSession(null);
      }
    })
    .catch((error) => {
      applyJobFailure(
        projectId,
        clipId,
        audioMode,
        durationSec,
        continuityMode,
        error,
      );
    })
    .finally(() => {
      inflight = false;
    });

  return true;
}

export function useAddAssetGenerationSession(
  projectId: string | null,
): AddAssetGenerationStoreSession | null {
  const snap = useSyncExternalStore(
    subscribeAddAssetGeneration,
    getAddAssetGenerationSession,
    getAddAssetGenerationSession,
  );
  if (!snap || !projectId || snap.projectId !== projectId) return null;
  return snap;
}

/** Test helper — reset module state between tests. */
export function __resetAddAssetGenerationStoreForTests(): void {
  session = null;
  inflight = false;
  applier = null;
  listeners.clear();
}
