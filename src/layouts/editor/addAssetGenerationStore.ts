import { convertFileSrc } from "@tauri-apps/api/core";
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
import type { StartFramePreview } from "./addAssetStartFrame";
import {
  creationIdFromWaitTimeoutError,
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
  resumeReplicateServiceJob,
} from "./addAssetReplicateGenerate";
import {
  BlueDirectPendingDownloadError,
  initialBlueDirectGenerationSteps,
  resumeBlueDirectAddAssetWait,
  resumeBlueDirectServiceJob,
} from "./addAssetBlueDirectGenerate";
import { addAssetClipDurationSec } from "./stagedClip";
import { cancelGenerateStillJob } from "../../services/generateStill";
import type { ReplicateVideoContinuity } from "./replicateRunConstraints";
import {
  durableFrameSourceFromPreview,
  frameSourceAssetId,
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "../../project/addAssetFrameSource";
import type { AddAssetFrameSource } from "../../project/types";
import { importLocalPathsForProject } from "../../project/projectAssetLanding";

/**
 * Prefer an existing image asset; otherwise file the local still into the
 * project so Generate new / Form review don't depend on live neighbors.
 */
async function ensureDurableFrameSource(
  preview: StartFramePreview | null | undefined,
  fallback: AddAssetFrameSource | undefined,
  projectId: string,
): Promise<AddAssetFrameSource | undefined> {
  const fromPreview = durableFrameSourceFromPreview(preview, fallback);
  if (fromPreview?.kind === "asset") return fromPreview;
  if (fallback?.kind === "asset") return fallback;
  const path = preview?.framePath?.trim();
  if (!path || !projectId.trim()) return fallback;
  try {
    const imported = await importLocalPathsForProject({
      paths: [path],
      projectId,
    });
    const id = imported.creations[0]?.id?.trim();
    if (id) return { kind: "asset", assetId: id };
  } catch {
    /* keep fallback */
  }
  return fallback;
}

/**
 * Per-clip add-asset generation sessions.
 * Survives EditorLayout unmount (e.g. switching to Library) so in-flight
 * jobs keep updating and can still write the finished clip into the project.
 * Remote job ids are also persisted on the placeholder draft so an app
 * restart can resume wait/download. Different clips may generate at once.
 */

export type AddAssetGenerationStoreSession = AddAssetGenerationSession & {
  projectId: string;
};

export type AddAssetGenerationSuccess = {
  projectId: string;
  clipId: string;
  creationId: string;
  projectCreationIds: string[];
  /** Throwaway local-* extracts to unfile after a Parascene still was used. */
  projectCreationIdsToRemove?: string[];
  videosGroupId: string | null;
  imagesGroupId: string | null;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  mode: AddAssetContinuityMode;
  model: string;
  /** Preview of the start still that was sent (for locked Form review). */
  startFramePreviewUrl?: string | null;
  endFramePreviewUrl?: string | null;
  /** Durable still sources captured from the frames actually sent. */
  firstFrameSource?: AddAssetFrameSource | null;
  lastFrameSource?: AddAssetFrameSource | null;
  startFrameAssetId?: string | null;
  inputVideoAssetId?: string | null;
  characterImageAssetId?: string | null;
  referenceImageAssetIds?: string[];
  referenceVideoAssetIds?: string[];
  referenceAudioAssetIds?: string[];
  timelineAudio?: "none" | "full_mix" | "vocals";
  startOffsetSeconds?: number;
};

/** Native folder_items after Generate: cabinet covers only, never members. */
export function generateFolderIdsToFile(result: {
  projectCreationIds?: readonly string[] | null;
  videosGroupId?: string | null;
  imagesGroupId?: string | null;
}): string[] {
  const covers = [result.videosGroupId, result.imagesGroupId]
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  if (covers.length > 0) return [...new Set(covers)];
  return [
    ...new Set(
      (result.projectCreationIds ?? [])
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  ];
}

function stampPreviewUrl(
  frame: StartFramePreview | null | undefined,
): string | undefined {
  const url = frame?.previewUrl?.trim();
  if (url) return url;
  const path = frame?.framePath?.trim();
  if (!path) return undefined;
  try {
    return convertFileSrc(path);
  } catch {
    return undefined;
  }
}

export type AddAssetGenerationFailure = {
  projectId: string;
  clipId: string;
  errorMessage: string;
  /**
   * string = set, null = clear, undefined = leave existing draft value.
   * Set when Replicate succeeded and only download/import needs retry.
   */
  replicatePredictionId?: string | null;
  /** Same idea for Direct to Blue download retry. */
  blueJobId?: string | null;
  /**
   * Parascene creation to keep waiting on after a local wait timeout.
   * Distinct from a hard provider failure — do not post a new create.
   */
  pendingCreationId?: string | null;
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

const sessions = new Map<string, AddAssetGenerationStoreSession>();
const inflightClips = new Set<string>();
/** Kernel job id per clip so Cancel can stop the backend run. */
const activeServiceJobByClip = new Map<string, string>();
/** Cancel clicked before the kernel job id was known — fire when it arrives. */
const cancelRequestedClips = new Set<string>();
let lastSessionClipId: string | null = null;
let sessionEpoch = 0;
let applier: AddAssetGenerationApplier | null = null;
const listeners = new Set<() => void>();
/** Clip ids currently being resumed (avoid double-start). */
const resumeAttempted = new Set<string>();
/**
 * Remote jobs that already produced a library import for this app session.
 * Prevents reconcile from re-downloading/importing the same Blue/Replicate/
 * Parascene job when it still sees a stale placeholder snapshot.
 */
const consumedRemoteJobs = new Set<string>();

function remoteJobKey(job: {
  replicatePredictionId?: string | null;
  pendingCreationId?: string | null;
  blueJobId?: string | null;
  serviceJobId?: string | null;
}): string | null {
  const service = job.serviceJobId?.trim();
  if (service) return `service:${service}`;
  const blue = job.blueJobId?.trim();
  if (blue) return `blue:${blue}`;
  const pred = job.replicatePredictionId?.trim();
  if (pred) return `replicate:${pred}`;
  const pending = job.pendingCreationId?.trim();
  if (pending) return `parascene:${pending}`;
  return null;
}

function markRemoteJobConsumed(job: {
  replicatePredictionId?: string | null;
  pendingCreationId?: string | null;
  blueJobId?: string | null;
  serviceJobId?: string | null;
}): void {
  const key = remoteJobKey(job);
  if (key) consumedRemoteJobs.add(key);
}

function isRemoteJobConsumed(job: {
  replicatePredictionId?: string | null;
  pendingCreationId?: string | null;
  blueJobId?: string | null;
  serviceJobId?: string | null;
}): boolean {
  const key = remoteJobKey(job);
  return Boolean(key && consumedRemoteJobs.has(key));
}

function emit(): void {
  sessionEpoch += 1;
  for (const listener of listeners) listener();
}

function setClipSession(
  clipId: string,
  next: AddAssetGenerationStoreSession | null,
): void {
  if (next) {
    sessions.set(clipId, next);
    lastSessionClipId = clipId;
  } else {
    sessions.delete(clipId);
    if (lastSessionClipId === clipId) {
      lastSessionClipId = sessions.keys().next().value ?? null;
    }
  }
  emit();
}

function patchSession(
  clipId: string,
  patch: Partial<AddAssetGenerationStoreSession>,
): void {
  const current = sessions.get(clipId);
  if (!current) return;
  sessions.set(clipId, { ...current, ...patch });
  emit();
}

export function getAddAssetGenerationSession(
  clipId?: string | null,
): AddAssetGenerationStoreSession | null {
  const id = clipId?.trim();
  if (id) return sessions.get(id) ?? null;
  if (lastSessionClipId) return sessions.get(lastSessionClipId) ?? null;
  return null;
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

export function isAddAssetGenerationInflight(clipId?: string | null): boolean {
  const id = clipId?.trim();
  if (id) return inflightClips.has(id);
  return inflightClips.size > 0;
}

export function clearAddAssetGenerationError(opts?: {
  projectId: string;
  clipId: string;
}): void {
  const projectId = opts?.projectId?.trim() || "";
  const clipId = opts?.clipId?.trim() || "";

  // Always clear the clip the user dismissed. Do not require the in-memory
  // session to still be in error — another placeholder may be generating.
  if (projectId && clipId) {
    applier?.clearFailure(projectId, clipId);
  } else {
    for (const s of sessions.values()) {
      if (s.phase === "error") {
        applier?.clearFailure(s.projectId, s.clipId);
      }
    }
  }

  // Drop the error session only when it belongs to the dismissed clip (or the
  // caller did not name a clip). Never clear a running job for another clip.
  if (clipId) {
    const s = sessions.get(clipId);
    if (s?.phase === "error") setClipSession(clipId, null);
  } else {
    for (const [id, s] of [...sessions.entries()]) {
      if (s.phase === "error") setClipSession(id, null);
    }
  }
}

/** Drop the session when its placeholder is no longer on the timeline. */
export function clearAddAssetGenerationIfClipMissing(
  timelineClipIds: ReadonlySet<string> | readonly string[],
): void {
  const ids =
    timelineClipIds instanceof Set
      ? timelineClipIds
      : new Set(timelineClipIds);
  let changed = false;
  for (const id of [...sessions.keys()]) {
    if (ids.has(id)) continue;
    sessions.delete(id);
    if (lastSessionClipId === id) {
      lastSessionClipId = sessions.keys().next().value ?? null;
    }
    changed = true;
  }
  if (changed) emit();
  // Do not clear inflight here. The running promise's `finally` owns that
  // flag — clearing early lets reconcile start a second download/import of
  // the same remote job (asset duplication storm).
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
    blueJobId:
      error instanceof BlueDirectPendingDownloadError ? error.blueJobId : null,
    pendingCreationId: creationIdFromWaitTimeoutError(message),
  });
  if (sessions.get(clipId)) {
    patchSession(clipId, {
      phase: "error",
      progressNote: "Generation failed",
      errorMessage: message,
    });
  } else {
    setClipSession(clipId, {
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
    | "mediaRefs"
  >;
};

/** Start (or no-op if this clip is already inflight). Returns false if this clip is already running. */
export function startAddAssetGenerationJob(
  opts: StartAddAssetGenerationJobOpts,
): boolean {
  const { projectId, request, runOpts } = opts;
  const clipId = request.clip.id;
  if (inflightClips.has(clipId)) return false;
  const continuityMode = request.continuityMode ?? "start_frame";
  inflightClips.add(clipId);
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
  } else if (request.blueDirect) {
    baseSession.steps = initialBlueDirectGenerationSteps(
      continuityMode,
      request.audioMode,
    );
  }
  setClipSession(clipId, {
    ...baseSession,
    projectId,
  });

  const provider: AddAssetGenerationJob["provider"] = request.replicate
    ? "replicate"
    : request.blueDirect
      ? "blue_direct"
      : "parascene_blue";
  const startedAt = new Date().toISOString();
  const modelHint = request.replicate
    ? `${request.replicate.owner}/${request.replicate.name}`
    : request.blueModel?.trim() || "blue";
  let activeRemote: {
    replicatePredictionId?: string;
    pendingCreationId?: string;
    blueJobId?: string;
    serviceJobId?: string;
  } = {};
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
    blueDirect: request.blueDirect,
    mediaRefs: request.mediaRefs,
    onSteps: (steps) => {
      patchSession(clipId, { steps });
    },
    onProgress: (progressNote) => {
      patchSession(clipId, { progressNote });
    },
    onRemoteJob: (remote) => {
      activeRemote = {
        replicatePredictionId: remote.replicatePredictionId,
        pendingCreationId: remote.pendingCreationId,
        blueJobId: remote.blueJobId,
        serviceJobId: remote.serviceJobId ?? activeRemote.serviceJobId,
      };
      const serviceJobId = activeRemote.serviceJobId?.trim();
      if (serviceJobId) {
        activeServiceJobByClip.set(clipId, serviceJobId);
        if (cancelRequestedClips.has(clipId)) {
          void cancelGenerateStillJob(serviceJobId).catch(() => {});
        }
      }
      persistInFlight(projectId, clipId, {
        status: "waiting",
        provider: remote.provider,
        startedAt,
        replicatePredictionId: remote.replicatePredictionId,
        pendingCreationId: remote.pendingCreationId,
        blueJobId: remote.blueJobId,
        serviceJobId: activeRemote.serviceJobId,
        model: remote.model ?? modelHint,
      });
    },
  })
    .then(async (result) => {
      const draftFirst =
        resolveFirstFrameSource({
          firstFrameSource: request.clip.addAssetDraft?.firstFrameSource,
          startFrameAssetId: request.clip.addAssetDraft?.startFrameAssetId,
        }) ??
        (continuityMode === "none" ? { kind: "none" as const } : { kind: "timeline" as const });
      const draftLast = resolveLastFrameSource({
        lastFrameSource: request.clip.addAssetDraft?.lastFrameSource,
        continuityMode,
      });
      // Parascene lane: stills are Creation members of the Images group.
      // Never re-import the temp ffmpeg extract as local-*, and never also
      // merge those still Creation ids into the flat project folder.
      const isParasceneLane = provider === "parascene_blue";
      const startCreationId = result.startFrameCreationId?.trim() || null;
      const endCreationId = result.endFrameCreationId?.trim() || null;
      const firstFrameSource: AddAssetFrameSource = startCreationId
        ? { kind: "asset", assetId: startCreationId }
        : isParasceneLane
          ? draftFirst
          : (await ensureDurableFrameSource(
              request.startFrame,
              draftFirst,
              projectId,
            )) ?? draftFirst;
      const lastFrameSource: AddAssetFrameSource =
        continuityMode === "first_last"
          ? endCreationId
            ? { kind: "asset", assetId: endCreationId }
            : isParasceneLane
              ? draftLast
              : (await ensureDurableFrameSource(
                  request.endFrame,
                  draftLast,
                  projectId,
                )) ?? draftLast
          : { kind: "none" };
      // Local-only servers keep imported stills as flat project members.
      // Parascene stills already live in the Images group cover.
      const stillIdsForFlatProject = isParasceneLane
        ? []
        : [
            frameSourceAssetId(firstFrameSource),
            frameSourceAssetId(lastFrameSource),
          ].filter((id): id is string => Boolean(id));
      const bridgeLocalIds = isParasceneLane
        ? [
            ...new Set(
              [
                request.clip.addAssetDraft?.startFrameAssetId?.trim(),
                frameSourceAssetId(draftFirst),
                frameSourceAssetId(draftLast),
              ].filter(
                (id): id is string =>
                  typeof id === "string" && id.startsWith("local-"),
              ),
            ),
          ]
        : [];
      const success: AddAssetGenerationSuccess = {
        projectId,
        clipId,
        creationId: result.creationId,
        projectCreationIds: generateFolderIdsToFile({
          projectCreationIds: [
            ...result.projectCreationIds,
            ...stillIdsForFlatProject,
          ],
          videosGroupId: result.videosGroupId,
          imagesGroupId: result.imagesGroupId,
        }),
        projectCreationIdsToRemove: bridgeLocalIds,
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt: request.prompt,
        lyricsText: request.lyricsText,
        audioMode: request.audioMode,
        mode: result.mode,
        model: result.model,
        startFramePreviewUrl: stampPreviewUrl(request.startFrame),
        endFramePreviewUrl: stampPreviewUrl(request.endFrame),
        firstFrameSource,
        lastFrameSource,
        startFrameAssetId: frameSourceAssetId(firstFrameSource),
        inputVideoAssetId: request.mediaRefs?.inputVideoAssetId ?? null,
        characterImageAssetId: request.mediaRefs?.characterImageAssetId ?? null,
        referenceImageAssetIds: request.mediaRefs?.referenceImageAssetIds,
        referenceVideoAssetIds: request.mediaRefs?.referenceVideoAssetIds,
        referenceAudioAssetIds: request.mediaRefs?.referenceAudioAssetIds,
        timelineAudio: request.mediaRefs?.timelineAudio,
        startOffsetSeconds: request.mediaRefs?.startOffsetSeconds,
      };
      markRemoteJobConsumed(activeRemote);
      await applier?.applySuccess(success);
      setClipSession(clipId, null);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // User-cancelled runs return to the form — no error card, no stale
      // generationJob marker to resume on restart.
      if (cancelRequestedClips.has(clipId) || message === "Cancelled") {
        applier?.clearFailure(projectId, clipId);
        setClipSession(clipId, null);
        return;
      }
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
      inflightClips.delete(clipId);
      resumeAttempted.delete(clipId);
      activeServiceJobByClip.delete(clipId);
      cancelRequestedClips.delete(clipId);
    });

  return true;
}

/**
 * Cancel this clip's in-flight generation. Stops the kernel job when its id is
 * known (or as soon as it becomes known) and returns the clip to the form.
 * The backend job is best-effort cancelled; a run that completes anyway still
 * files its asset via applySuccess.
 */
export function cancelAddAssetGeneration(clipId: string): void {
  const id = clipId.trim();
  if (!id) return;
  if (!inflightClips.has(id)) {
    // No live promise owns this clip (e.g. stale session after restart) —
    // just clear it so the editor is usable again.
    const stale = sessions.get(id);
    if (stale) {
      applier?.clearFailure(stale.projectId, id);
      setClipSession(id, null);
    }
    return;
  }
  cancelRequestedClips.add(id);
  patchSession(id, { progressNote: "Cancelling…" });
  const serviceJobId = activeServiceJobByClip.get(id);
  if (serviceJobId) {
    void cancelGenerateStillJob(serviceJobId).catch(() => {});
  }
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
  if (inflightClips.has(opts.clipId)) return false;
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
  inflightClips.add(clipId);
  resumeAttempted.add(clipId);
  const baseSession = createRunningAddAssetGenerationSession(
    clipId,
    audioMode,
    durationSec,
    continuityMode,
  );
  baseSession.steps = initialReplicateDownloadRetrySteps();
  baseSession.progressNote = "Retrying download…";
  setClipSession(clipId, {
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
        projectCreationIds: generateFolderIdsToFile({
          projectCreationIds: result.projectCreationIds,
          videosGroupId: result.videosGroupId,
          imagesGroupId: result.imagesGroupId,
        }),
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt,
        lyricsText,
        audioMode,
        mode: result.mode,
        model: result.model,
      };
      markRemoteJobConsumed({ replicatePredictionId: predictionId });
      await applier?.applySuccess(success);
      setClipSession(clipId, null);
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
      inflightClips.delete(clipId);
      resumeAttempted.delete(clipId);
    });

  return true;
}

export type ResumeTimedOutParasceneWaitOpts = {
  projectId: string;
  projectTitle: string;
  clipId: string;
  pendingCreationId: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  prompt: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode;
  durationSec: number;
  model: string;
};

/**
 * Local wait budget expired — poll the same Parascene creation again.
 * Does not POST a new create.
 */
export function resumeTimedOutParasceneWait(
  opts: ResumeTimedOutParasceneWaitOpts,
): boolean {
  const clipId = opts.clipId.trim();
  const pendingCreationId = opts.pendingCreationId.trim();
  if (!clipId || !pendingCreationId) return false;
  if (inflightClips.has(clipId)) return false;
  inflightClips.add(clipId);
  resumeAttempted.add(clipId);
  const baseSession = createRunningAddAssetGenerationSession(
    clipId,
    opts.audioMode,
    opts.durationSec,
    opts.continuityMode,
  );
  baseSession.steps = [
    { id: "generate", label: "Generate video", status: "active" },
    { id: "file", label: "Add to project", status: "pending" },
  ];
  baseSession.progressNote = `Checking creation ${pendingCreationId}…`;
  setClipSession(clipId, {
    ...baseSession,
    projectId: opts.projectId,
  });
  persistInFlight(opts.projectId, clipId, {
    status: "waiting",
    provider: "parascene_blue",
    startedAt: new Date().toISOString(),
    pendingCreationId,
    model: opts.model,
  });

  void resumeParasceneAddAssetGeneration({
    pendingCreationId,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    continuityMode: opts.continuityMode,
    model: opts.model,
    onSteps: (steps) => patchSession(clipId, { steps }),
    onProgress: (progressNote) => patchSession(clipId, { progressNote }),
  })
    .then(async (result) => {
      const success: AddAssetGenerationSuccess = {
        projectId: opts.projectId,
        clipId,
        creationId: result.creationId,
        projectCreationIds: generateFolderIdsToFile({
          projectCreationIds: result.projectCreationIds,
          videosGroupId: result.videosGroupId,
          imagesGroupId: result.imagesGroupId,
        }),
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt: opts.prompt,
        lyricsText: "",
        audioMode: opts.audioMode,
        mode: result.mode,
        model: result.model,
      };
      markRemoteJobConsumed({ pendingCreationId });
      await applier?.applySuccess(success);
      setClipSession(clipId, null);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelRequestedClips.has(clipId) || message === "Cancelled") {
        applier?.clearFailure(opts.projectId, clipId);
        setClipSession(clipId, null);
        return;
      }
      applyJobFailure(
        opts.projectId,
        clipId,
        opts.audioMode,
        opts.durationSec,
        opts.continuityMode,
        error,
      );
    })
    .finally(() => {
      inflightClips.delete(clipId);
      resumeAttempted.delete(clipId);
      activeServiceJobByClip.delete(clipId);
      cancelRequestedClips.delete(clipId);
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
 * placeholders. One job per clip; different clips can run together.
 */
export function reconcileAddAssetGenerations(
  opts: ReconcileAddAssetGenerationsOpts,
): boolean {
  if (!applier) return false;
  const candidates = findResumableAddAssetPlaceholders(opts.timeline).filter(
    (c) =>
      !resumeAttempted.has(c.clip.id) &&
      !isRemoteJobConsumed({
        replicatePredictionId:
          c.job.replicatePredictionId ??
          c.clip.addAssetDraft?.replicatePredictionId,
        pendingCreationId: c.job.pendingCreationId,
        blueJobId: c.job.blueJobId ?? c.clip.addAssetDraft?.blueJobId,
        serviceJobId: c.job.serviceJobId,
      }),
  );
  if (candidates.length === 0) return false;

  // Prefer a job that already has a remote id.
  const withRemote =
    candidates.find(
      (c) =>
        Boolean(c.job.serviceJobId?.trim()) ||
        Boolean(c.job.replicatePredictionId?.trim()) ||
        Boolean(c.job.pendingCreationId?.trim()) ||
        Boolean(c.job.blueJobId?.trim()),
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
  const blueJobId =
    job.blueJobId?.trim() || draft?.blueJobId?.trim() || "";
  const serviceJobId = job.serviceJobId?.trim() || "";

  if (
    job.status === "starting" &&
    !predictionId &&
    !pendingCreationId &&
    !blueJobId &&
    !serviceJobId
  ) {
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

  inflightClips.add(clipId);
  resumeAttempted.add(clipId);
  if (serviceJobId) activeServiceJobByClip.set(clipId, serviceJobId);
  const baseSession = initialResumeSessionSteps(
    job.provider,
    continuityMode,
    audioMode,
    durationSec,
  );
  setClipSession(clipId, {
    ...baseSession,
    clipId,
    projectId: opts.projectId,
  });

  const run =
    serviceJobId
      ? job.provider === "parascene_blue"
        ? resumeParasceneAddAssetGeneration({
            serviceJobId,
            pendingCreationId: pendingCreationId || undefined,
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
        : job.provider === "blue_direct"
          ? resumeBlueDirectServiceJob({
              serviceJobId,
              projectId: opts.projectId,
              imagesGroupId: opts.imagesGroupId,
              continuityMode,
              model: job.model?.trim() || "blue_direct",
              onSteps: (steps) => patchSession(clipId, { steps }),
              onProgress: (progressNote) =>
                patchSession(clipId, { progressNote }),
            })
          : resumeReplicateServiceJob({
              serviceJobId,
              projectId: opts.projectId,
              imagesGroupId: opts.imagesGroupId,
              continuityMode: continuityMode as ReplicateVideoContinuity,
              modelId:
                job.model?.trim() ||
                draft?.replicateModel?.trim() ||
                "replicate",
              onSteps: (steps) => patchSession(clipId, { steps }),
              onProgress: (progressNote) =>
                patchSession(clipId, { progressNote }),
            })
      : job.provider === "replicate" && predictionId
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
      : job.provider === "blue_direct" && blueJobId
        ? resumeBlueDirectAddAssetWait({
            blueJobId,
            projectId: opts.projectId,
            imagesGroupId: opts.imagesGroupId,
            continuityMode,
            model: job.model?.trim() || "blue_direct",
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
        projectCreationIds: generateFolderIdsToFile({
          projectCreationIds: result.projectCreationIds,
          videosGroupId: result.videosGroupId,
          imagesGroupId: result.imagesGroupId,
        }),
        videosGroupId: result.videosGroupId,
        imagesGroupId: result.imagesGroupId,
        prompt,
        lyricsText,
        audioMode,
        mode: result.mode,
        model: result.model,
      };
      markRemoteJobConsumed({
        replicatePredictionId: predictionId || null,
        pendingCreationId: pendingCreationId || null,
        blueJobId: blueJobId || null,
        serviceJobId: serviceJobId || null,
      });
      await applier?.applySuccess(success);
      setClipSession(clipId, null);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelRequestedClips.has(clipId) || message === "Cancelled") {
        applier?.clearFailure(opts.projectId, clipId);
        setClipSession(clipId, null);
        return;
      }
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
      inflightClips.delete(clipId);
      resumeAttempted.delete(clipId);
      activeServiceJobByClip.delete(clipId);
      cancelRequestedClips.delete(clipId);
      // Do not re-enter with this stale `opts.timeline` snapshot — it still
      // contains the placeholder we just filled, which re-imports the same
      // remote output in a loop. ShellProvider's resume effect re-runs when
      // the live timeline fingerprint changes and picks up any remaining jobs.
    });

  void Promise.resolve().then(() => {
    reconcileAddAssetGenerations(opts);
  });
  return true;
}

export function useAddAssetGenerationSession(
  projectId: string | null,
  clipId?: string | null,
): AddAssetGenerationStoreSession | null {
  const epoch = useSyncExternalStore(
    subscribeAddAssetGeneration,
    () => sessionEpoch,
    () => sessionEpoch,
  );
  void epoch;
  const snap = getAddAssetGenerationSession(clipId);
  if (!snap || !projectId || snap.projectId !== projectId) return null;
  return snap;
}

/** Test helper — reset module state between tests. */
export function __resetAddAssetGenerationStoreForTests(): void {
  sessions.clear();
  inflightClips.clear();
  lastSessionClipId = null;
  sessionEpoch = 0;
  applier = null;
  listeners.clear();
  resumeAttempted.clear();
  consumedRemoteJobs.clear();
  activeServiceJobByClip.clear();
  cancelRequestedClips.clear();
}
