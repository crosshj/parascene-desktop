import { useSyncExternalStore } from "react";
import type {
  AddAssetGenerationJob,
  TimelineClip,
} from "../../project/types";
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
  draftAudioMode,
  draftContinuityMode,
  findResumableAddAssetPlaceholders,
  initialResumeSessionSteps,
  resumeParasceneAddAssetGeneration,
  resumeReplicateWaitForPlaceholder,
} from "./addAssetGenerationResume";
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
 * Remote job ids are also persisted on the placeholder draft so an app
 * restart can resume wait/download.
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

export type AddAssetGenerationInFlight = {
  projectId: string;
  clipId: string;
  job: AddAssetGenerationJob;
};

export type AddAssetGenerationApplier = {
  applySuccess: (result: AddAssetGenerationSuccess) => void | Promise<void>;
  /** Persist failure on the placeholder so the timeline ! survives navigation. */
  applyFailure: (result: AddAssetGenerationFailure) => void;
  /** Clear persisted failure when the user dismisses / retries. */
  clearFailure: (projectId: string, clipId: string) => void;
  /** Persist in-flight remote job markers for app-restart resume. */
  applyInFlight: (result: AddAssetGenerationInFlight) => void;
};

let session: AddAssetGenerationStoreSession | null = null;
let inflight = false;
let applier: AddAssetGenerationApplier | null = null;
const listeners = new Set<() => void>();
/** Clip ids currently being resumed (avoid double-start). */
const resumeAttempted = new Set<string>();

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

function persistInFlight(
  projectId: string,
  clipId: string,
  job: AddAssetGenerationJob,
): void {
  applier?.applyInFlight({ projectId, clipId, job });
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
    | "onSteps"
    | "onProgress"
    | "onRemoteJob"
    | "prompt"
    | "lyricsText"
    | "audioMode"
    | "continuityMode"
    | "startFrame"
    | "endFrame"
    | "placeholder"
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
  resumeAttempted.add(clipId);
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

  const provider: AddAssetGenerationJob["provider"] = request.replicate
    ? "replicate"
    : "parascene_blue";
  const startedAt = new Date().toISOString();
  const modelHint = request.replicate
    ? `${request.replicate.owner}/${request.replicate.name}`
    : request.blueModel === "wan"
      ? "wan"
      : "ltx";
  // applyInFlight clears lastError / stale prediction ids — avoid racing clearFailure.
  persistInFlight(projectId, clipId, {
    status: "starting",
    provider,
    startedAt,
    model: modelHint,
  });

  void runAddAssetGeneration({
    ...runOpts,
    placeholder: request.clip,
    prompt: request.prompt,
    lyricsText: request.lyricsText,
    audioMode: request.audioMode,
    continuityMode,
    blueModel: request.blueModel,
    startFrame: request.startFrame,
    endFrame: request.endFrame,
    replicate: request.replicate,
    onSteps: (steps) => {
      patchSession(clipId, { steps });
    },
    onProgress: (progressNote) => {
      patchSession(clipId, { progressNote });
    },
    onRemoteJob: (remote) => {
      persistInFlight(projectId, clipId, {
        status: "waiting",
        provider: remote.provider,
        startedAt,
        replicatePredictionId: remote.replicatePredictionId,
        pendingCreationId: remote.pendingCreationId,
        model: remote.model ?? modelHint,
      });
    },
  })
    .then(async (result) => {
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
      await applier?.applySuccess(success);
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
      resumeAttempted.delete(clipId);
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
  resumeAttempted.add(clipId);
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
  // Clears lastError and stamps prediction id for resume.
  persistInFlight(projectId, clipId, {
    status: "downloading",
    provider: "replicate",
    startedAt: new Date().toISOString(),
    replicatePredictionId: predictionId,
    model: modelId,
  });

  void resumeReplicateAddAssetDownload({
    predictionId,
    projectId,
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
    .then(async (result) => {
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
      await applier?.applySuccess(success);
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
      resumeAttempted.delete(clipId);
    });

  return true;
}

export type ReconcileAddAssetGenerationsOpts = {
  projectId: string;
  projectTitle: string;
  timeline: readonly TimelineClip[];
  imagesGroupId: string | null;
  videosGroupId: string | null;
};

/**
 * After project load / app restart: reattach to remote jobs persisted on
 * placeholders. One global job at a time (same as live generation).
 */
export function reconcileAddAssetGenerations(
  opts: ReconcileAddAssetGenerationsOpts,
): boolean {
  if (inflight || !applier) return false;
  const candidates = findResumableAddAssetPlaceholders(opts.timeline).filter(
    (c) => !resumeAttempted.has(c.clip.id),
  );
  if (candidates.length === 0) return false;

  // Prefer a job that already has a remote id.
  const withRemote =
    candidates.find(
      (c) =>
        Boolean(c.job.replicatePredictionId?.trim()) ||
        Boolean(c.job.pendingCreationId?.trim()),
    ) ?? candidates[0];
  if (!withRemote) return false;

  const { clip, job } = withRemote;
  const clipId = clip.id;
  const draft = clip.addAssetDraft;
  const audioMode = draftAudioMode(draft);
  const continuityMode = draftContinuityMode(draft);
  const durationSec = addAssetClipDurationSec(clip);
  const prompt = draft?.prompt?.trim() || "";
  const lyricsText = "";
  const predictionId =
    job.replicatePredictionId?.trim() ||
    draft?.replicatePredictionId?.trim() ||
    "";
  const pendingCreationId = job.pendingCreationId?.trim() || "";

  if (job.status === "starting" && !predictionId && !pendingCreationId) {
    resumeAttempted.add(clipId);
    applyJobFailure(
      opts.projectId,
      clipId,
      audioMode,
      durationSec,
      continuityMode,
      new Error(
        "Generation was interrupted before a remote job was created. Please try again.",
      ),
    );
    resumeAttempted.delete(clipId);
    // Try next candidate if any.
    return reconcileAddAssetGenerations(opts);
  }

  inflight = true;
  resumeAttempted.add(clipId);
  const baseSession = initialResumeSessionSteps(
    job.provider,
    continuityMode,
    audioMode,
    durationSec,
  );
  setSession({
    ...baseSession,
    clipId,
    projectId: opts.projectId,
  });

  const run =
    job.provider === "replicate" && predictionId
      ? resumeReplicateWaitForPlaceholder({
          predictionId,
          projectId: opts.projectId,
          imagesGroupId: opts.imagesGroupId,
          continuityMode,
          modelId:
            job.model?.trim() ||
            draft?.replicateModel?.trim() ||
            "replicate",
          onSteps: (steps) => patchSession(clipId, { steps }),
          onProgress: (progressNote) =>
            patchSession(clipId, { progressNote }),
        })
      : pendingCreationId
        ? resumeParasceneAddAssetGeneration({
            pendingCreationId,
            projectId: opts.projectId,
            projectTitle: opts.projectTitle,
            imagesGroupId: opts.imagesGroupId,
            videosGroupId: opts.videosGroupId,
            continuityMode,
            model: job.model?.trim() || "parascene_blue",
            onSteps: (steps) => patchSession(clipId, { steps }),
            onProgress: (progressNote) =>
              patchSession(clipId, { progressNote }),
          })
        : Promise.reject(
            new Error("No remote job id available to resume generation."),
          );

  void run
    .then(async (result) => {
      const success: AddAssetGenerationSuccess = {
        projectId: opts.projectId,
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
      await applier?.applySuccess(success);
      if (session?.clipId === clipId) {
        setSession(null);
      }
    })
    .catch((error) => {
      applyJobFailure(
        opts.projectId,
        clipId,
        audioMode,
        durationSec,
        continuityMode,
        error,
      );
    })
    .finally(() => {
      inflight = false;
      resumeAttempted.delete(clipId);
      // Kick another pending placeholder if present.
      reconcileAddAssetGenerations(opts);
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
  resumeAttempted.clear();
}
