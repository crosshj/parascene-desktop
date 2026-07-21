import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../../app/ShellProvider";
import { createAuthedSdk } from "../../auth/session";
import {
  deleteLocal,
  getCreations,
  importLocalPaths,
} from "../../library/catalogClient";
import { isGroupCreation } from "../../library/creationFlags";
import { creationDetailUrl } from "../../library/previewUrl";
import type { Creation } from "../../library/types";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  cancelProjectGroupsJob,
  cleanupProjectGroups,
  ensureProjectGroups,
  fileCreationIntoProjectGroup,
  isCancelledError,
  isDetachedError,
  resolveLatestImagesGroupStill,
  type EnsureCheckpoint,
} from "../../lab/projectGroups";
import { useConfirm } from "../../ui/ConfirmDialog";
import {
  bakeClipExtend,
  cachedFullVocalsPath,
  deleteAudioClip,
  separateFullVocals,
  sliceAudioRange,
  uploadVocalsSliceClip,
} from "../../lab/audioTools";
import { LabAudioTrack, LabWaveformSlicePicker } from "../../lab/LabMediaWaveform";
import { LabImagePicker } from "../../lab/LabImagePicker";
import { LabVideoRangePicker } from "../../lab/LabVideoRangePicker";
import { CreationLightbox } from "../../library/CreationLightbox";
import { ingestRemoteCreation, newCreationToken } from "../../lab/ingestCreation";
import {
  LAB_A2V_PROMPT,
  LAB_ANIMATE_PROMPT,
  LAB_MUTATE_PROMPT,
  LAB_STILL_PROMPT,
} from "../../lab/labPrompts";
import {
  getLabDepsStatus,
  LAB_DEPS_CHANGED_EVENT,
} from "../../lab/labDeps";
import {
  hasOpenAiApiKey,
  LAB_SHOT_CATALOG,
  loadOpenAiApiKey,
  openAiChatCompletion,
} from "../../lab/openaiClient";
import {
  loadLabSession,
  sanitizeLabSession,
  saveLabSession,
  vocalsClipMatchesSlice,
  type LabLastResult,
  type LabSessionSnapshot,
  type LabVocalsClip,
  type LabVocalsSlice,
} from "../../lab/labSession";
import {
  OPENAI_KEY_CHANGED_EVENT,
  requestOpenSettings,
} from "../../settings/events";
import { labModuleGate } from "./labGates";
import { LAB_MODULES, type LabModuleId } from "./labTypes";

function remoteMediaUrl(c: Creation): string | null {
  if (c.remoteUrl?.trim()) return c.remoteUrl.trim();
  if (c.videoUrl?.trim()) return c.videoUrl.trim();
  if (!c.remoteJson) return null;
  try {
    const raw = JSON.parse(c.remoteJson) as {
      url?: string;
      video_url?: string;
    };
    return raw.url || raw.video_url || null;
  } catch {
    return null;
  }
}

function creationPlayUrl(c: Creation | undefined): string | null {
  if (!c) return null;
  return creationDetailUrl(c) ?? remoteMediaUrl(c);
}

function LabResultMedia({
  playUrl,
  mediaType,
}: {
  playUrl: string;
  mediaType: "audio" | "video";
}) {
  if (mediaType === "video") {
    return (
      <video
        controls
        src={playUrl}
        className="lab-video"
        playsInline
        preload="metadata"
      />
    );
  }
  return <audio controls src={playUrl} className="lab-audio" />;
}

type LastResult = LabLastResult;

type RunCtx = {
  onProgress: (note: string) => void;
  /** Persist in-flight Parascene id so leaving Lab mid-poll can resume. */
  onPendingCreation: (
    id: string | null,
    mediaType?: "image" | "video" | null,
  ) => void;
};
type Runner = (fn: (ctx: RunCtx) => Promise<LastResult>) => void;

export function LabLayout() {
  const {
    project,
    setOpenProjectGroupIds,
    setOpenProjectMainAudioCreationId,
    addCreationsToOpenProject,
    removeCreationsFromOpenProject,
    closeProject,
  } = useShell();
  const confirm = useConfirm();

  const [session, setSession] = useState<LabSessionSnapshot>(() =>
    loadLabSession(project.id),
  );

  const resumeGroupsRef = useRef(false);
  const resumeEnsurePayloadRef = useRef<{
    backendJobId: string | null;
    pendingCreationId: string | null;
    imagesGroupId: string | null;
    videosGroupId: string | null;
  } | null>(null);
  const resumePendingRef = useRef<{
    moduleId: LabModuleId;
    pendingCreationId: string;
    pendingMediaType: "image" | "video";
  } | null>(null);
  const ensureAbortRef = useRef<AbortController | null>(null);
  const ensureBackendJobIdRef = useRef<string | null>(null);
  const [ensureCancellable, setEnsureCancellable] = useState(false);

  // Reload when switching projects. In-flight backend jobs auto-resume.
  useEffect(() => {
    const loaded = sanitizeLabSession(loadLabSession(project.id));
    const job = loaded.activeJob;
    const groupsWasRunning =
      job?.moduleId === "groups" ||
      loaded.moduleProgress.groups?.status === "running";
    const pendingCreationId = job?.pendingCreationId?.trim() || null;
    const backendJobId = job?.backendJobId?.trim() || null;
    const pendingModule =
      job?.moduleId && job.moduleId !== "groups" ? job.moduleId : null;
    const canResumePending =
      Boolean(pendingCreationId) &&
      Boolean(pendingModule) &&
      (pendingModule === "create" ||
        pendingModule === "mutate" ||
        pendingModule === "a2v");

    if (groupsWasRunning) {
      const imagesGroupId =
        job?.imagesGroupId ?? project.imagesGroupId;
      const videosGroupId =
        job?.videosGroupId ?? project.videosGroupId;
      const resumed: LabSessionSnapshot = {
        ...loaded,
        moduleId: "groups",
        moduleProgress: {
          ...loaded.moduleProgress,
          groups: {
            status: "running",
            note: "Resuming…",
          },
        },
        progressLogByModule: {
          ...loaded.progressLogByModule,
          groups: [
            ...(loaded.progressLogByModule.groups ?? []),
            backendJobId
              ? `Returned to Lab — attaching to backend job ${backendJobId}.`
              : "Returned to Lab — resuming ensure (backend will avoid double-mint when possible).",
          ].slice(-40),
        },
        activeJob: {
          moduleId: "groups",
          phase: "resuming",
          startedAt: job?.startedAt || new Date().toISOString(),
          backendJobId,
          pendingCreationId,
          imagesGroupId,
          videosGroupId,
        },
      };
      // Intentional: restore persisted session when resuming an in-flight job.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSession(resumed);
      saveLabSession(project.id, resumed);
      resumeEnsurePayloadRef.current = {
        backendJobId,
        pendingCreationId,
        imagesGroupId,
        videosGroupId,
      };
      resumeGroupsRef.current = true;
    } else if (canResumePending && pendingCreationId && pendingModule) {
      const mediaType: "image" | "video" =
        job?.pendingMediaType === "video" || pendingModule === "a2v"
          ? "video"
          : "image";
      const resumed: LabSessionSnapshot = {
        ...loaded,
        moduleId: pendingModule,
        moduleProgress: {
          ...loaded.moduleProgress,
          [pendingModule]: {
            status: "running",
            note: `Resuming wait for ${pendingCreationId}…`,
          },
        },
        progressLogByModule: {
          ...loaded.progressLogByModule,
          [pendingModule]: [
            ...(loaded.progressLogByModule[pendingModule] ?? []),
            `Returned to Lab — resuming wait for ${pendingCreationId} (leaving while polling is fine).`,
          ].slice(-40),
        },
        activeJob: {
          moduleId: pendingModule,
          phase: "resuming",
          startedAt: job?.startedAt || new Date().toISOString(),
          pendingCreationId,
          pendingMediaType: mediaType,
          imagesGroupId: job?.imagesGroupId ?? project.imagesGroupId,
          videosGroupId: job?.videosGroupId ?? project.videosGroupId,
        },
      };
      setSession(resumed);
      saveLabSession(project.id, resumed);
      resumePendingRef.current = {
        moduleId: pendingModule,
        pendingCreationId,
        pendingMediaType: mediaType,
      };
    } else if (
      job ||
      Object.values(loaded.moduleProgress).some((p) => p?.status === "running")
    ) {
      // Local-only jobs (isolate/extend/etc.) can't resume after unmount.
      const interruptedModule =
        job?.moduleId ??
        (Object.entries(loaded.moduleProgress).find(
          ([, prog]) => prog?.status === "running",
        )?.[0] as LabModuleId | undefined) ??
        loaded.moduleId;
      const interrupted: LabSessionSnapshot = {
        ...loaded,
        activeJob: null,
        moduleProgress: { ...loaded.moduleProgress },
        progressLogByModule: {
          ...loaded.progressLogByModule,
          [interruptedModule]: [
            ...(loaded.progressLogByModule[interruptedModule] ?? []),
            "Returned to Lab — a local-only step was still running and can’t resume; re-run if needed.",
          ].slice(-40),
        },
      };
      for (const [id, prog] of Object.entries(interrupted.moduleProgress)) {
        if (prog?.status === "running") {
          interrupted.moduleProgress[id as LabModuleId] = {
            status: "failed",
            note: `Stopped: ${prog.note || job?.phase || "left Lab"}`,
          };
        }
      }
      setSession(interrupted);
      saveLabSession(project.id, interrupted);
    } else {
      setSession(loaded);
    }
    // Only on project switch — not when group ids update mid-ensure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Persist so leaving Lab / remount keeps progress + last result.
  useEffect(() => {
    saveLabSession(project.id, session);
  }, [project.id, session]);

  // Detach FE watchers on leave — do not cancel the Rust job (resume attaches by UUID).
  useEffect(() => {
    return () => {
      ensureAbortRef.current?.abort();
    };
  }, []);

  const moduleId = session.moduleId;
  const setModuleId = (id: LabModuleId) => {
    setButtonLabel(null);
    setSession((s) => ({ ...s, moduleId: id }));
  };

  const setVocalsSlice = useCallback((slice: LabVocalsSlice | null) => {
    setSession((s) => ({ ...s, vocalsSlice: slice }));
  }, []);

  const setVocalsClip = useCallback((clip: LabVocalsClip | null) => {
    setSession((s) => ({ ...s, vocalsClip: clip }));
  }, []);

  const [credits, setCredits] = useState<number | null>(null);
  const [assets, setAssets] = useState<Creation[]>([]);
  const [buttonLabel, setButtonLabel] = useState<string | null>(null);

  const refreshAssets = useCallback(async () => {
    if (project.assets.length === 0) {
      setAssets([]);
      return;
    }
    const rows = await getCreations(project.assets.map((a) => a.id));
    setAssets(rows);
  }, [project.assets]);

  useEffect(() => {
    // Intentional: load project assets (async setState) when the list changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAssets();
  }, [refreshAssets]);

  useEffect(() => {
    void createAuthedSdk()
      .getCredits()
      .then((c) => setCredits(c.balance))
      .catch(() => setCredits(null));
  }, [session.lastByModule]);

  const groupsReady = Boolean(
    project.imagesGroupId && project.videosGroupId,
  );
  const [openAiReady, setOpenAiReady] = useState(() => hasOpenAiApiKey());
  const [ffmpegReady, setFfmpegReady] = useState(true);
  const [demucsReady, setDemucsReady] = useState(true);

  useEffect(() => {
    const refresh = () => setOpenAiReady(hasOpenAiApiKey());
    refresh();
    window.addEventListener(OPENAI_KEY_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(OPENAI_KEY_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getLabDepsStatus()
        .then((s) => {
          if (cancelled) return;
          setFfmpegReady(s.ffmpeg.ready);
          setDemucsReady(s.demucs.ready);
        })
        .catch(() => {
          if (cancelled) return;
          setFfmpegReady(false);
          setDemucsReady(false);
        });
    };
    refresh();
    window.addEventListener(LAB_DEPS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(LAB_DEPS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  // Drop stale Create/etc. results that still hold Project groups cleanup output.
  useEffect(() => {
    // Intentional: sanitize persisted session once on project/group change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession((s) => {
      const next = sanitizeLabSession(s);
      if (
        next.lastByModule === s.lastByModule &&
        next.progressLogByModule === s.progressLogByModule
      ) {
        return s;
      }
      return next;
    });
  }, [project.id, project.imagesGroupId, project.videosGroupId]);

  const audioAssets = useMemo(
    () => assets.filter((c) => c.mediaType === "audio"),
    [assets],
  );
  // Exclude Images / Videos group covers — they duplicate a member already listed.
  const imageAssets = useMemo(
    () =>
      assets.filter(
        (c) =>
          c.mediaType === "image" &&
          !isGroupCreation(c) &&
          c.id !== project.imagesGroupId,
      ),
    [assets, project.imagesGroupId],
  );
  const videoAssets = useMemo(
    () =>
      assets.filter(
        (c) =>
          c.mediaType === "video" &&
          !isGroupCreation(c) &&
          c.id !== project.videosGroupId,
      ),
    [assets, project.videosGroupId],
  );

  const mainAudioId =
    project.mainAudioCreationId || audioAssets[0]?.id || "";

  const gateCtx = {
    groupsReady,
    assetCount: assets.length,
    audioCount: audioAssets.length,
    imageCount: imageAssets.length,
    videoCount: videoAssets.length,
    openAiReady,
    ffmpegReady,
    demucsReady,
    vocalsSliceReady: Boolean(session.vocalsSlice?.path),
  };
  const activeGate = labModuleGate(moduleId, gateCtx);

  const moduleBusy = session.moduleProgress[moduleId]?.status === "running";
  const anyBusy = Object.values(session.moduleProgress).some(
    (p) => p?.status === "running",
  );

  const appendProgress = useCallback((forModule: LabModuleId, note: string) => {
    setSession((s) => ({
      ...s,
      progressLogByModule: {
        ...s.progressLogByModule,
        [forModule]: [
          ...(s.progressLogByModule[forModule] ?? []),
          note,
        ].slice(-40),
      },
    }));
    setButtonLabel(note);
  }, []);

  const setPendingCreation = useCallback(
    (
      forModule: LabModuleId,
      pendingCreationId: string | null,
      pendingMediaType?: "image" | "video" | null,
    ) => {
      setSession((s) => ({
        ...s,
        activeJob: s.activeJob
          ? {
              ...s.activeJob,
              moduleId: forModule,
              pendingCreationId,
              pendingMediaType:
                pendingMediaType !== undefined
                  ? pendingMediaType
                  : s.activeJob.pendingMediaType,
            }
          : {
              moduleId: forModule,
              phase: pendingCreationId
                ? `Waiting for ${pendingCreationId}`
                : "starting",
              startedAt: new Date().toISOString(),
              pendingCreationId,
              pendingMediaType: pendingMediaType ?? null,
              imagesGroupId: project.imagesGroupId,
              videosGroupId: project.videosGroupId,
            },
      }));
    },
    [project.imagesGroupId, project.videosGroupId],
  );

  const run = async (
    forModule: LabModuleId,
    fn: (ctx: RunCtx) => Promise<LastResult>,
    opts?: { keepProgressLog?: boolean },
  ) => {
    setSession((s) => ({
      ...s,
      moduleId: forModule,
      progressLogByModule: {
        ...s.progressLogByModule,
        [forModule]: opts?.keepProgressLog
          ? (s.progressLogByModule[forModule] ?? [])
          : [],
      },
      moduleProgress: {
        ...s.moduleProgress,
        [forModule]: { status: "running", note: "Starting…" },
      },
      activeJob: {
        moduleId: forModule,
        phase: "starting",
        startedAt: s.activeJob?.startedAt || new Date().toISOString(),
        backendJobId: opts?.keepProgressLog
          ? (s.activeJob?.backendJobId ?? null)
          : null,
        pendingCreationId: opts?.keepProgressLog
          ? (s.activeJob?.pendingCreationId ?? null)
          : null,
        pendingMediaType: opts?.keepProgressLog
          ? (s.activeJob?.pendingMediaType ?? null)
          : null,
        imagesGroupId: s.activeJob?.imagesGroupId ?? project.imagesGroupId,
        videosGroupId: s.activeJob?.videosGroupId ?? project.videosGroupId,
      },
      lastByModule: {
        ...s.lastByModule,
        [forModule]: undefined,
      },
    }));
    setButtonLabel("Starting…");
    try {
      const result = await fn({
        onProgress: (note) => {
          appendProgress(forModule, note);
          setSession((s) => ({
            ...s,
            moduleProgress: {
              ...s.moduleProgress,
              [forModule]: { status: "running", note },
            },
            activeJob: s.activeJob
              ? { ...s.activeJob, phase: note }
              : s.activeJob,
          }));
        },
        onPendingCreation: (id, mediaType) =>
          setPendingCreation(forModule, id, mediaType),
      });
      setSession((s) => ({
        ...s,
        lastByModule: {
          ...s.lastByModule,
          [forModule]: result,
        },
        activeJob: null,
        moduleProgress: {
          ...s.moduleProgress,
          [forModule]: { status: "ok", note: result.summary },
        },
      }));
      setButtonLabel(null);
      await refreshAssets();
    } catch (err) {
      // Left Lab (or remounted) while watching a backend job — keep activeJob
      // so resume can re-attach to the same UUID.
      if (isDetachedError(err)) {
        setButtonLabel(null);
        return;
      }
      const cancelled = isCancelledError(err);
      const message = cancelled
        ? "Cancelled"
        : err instanceof Error
          ? err.message
          : String(err);
      setSession((s) => ({
        ...s,
        activeJob: null,
        lastByModule: {
          ...s.lastByModule,
          [forModule]: {
            summary: cancelled ? "Cancelled" : "Failed",
            detail: message,
          },
        },
        moduleProgress: {
          ...s.moduleProgress,
          [forModule]: {
            status: "failed",
            note: cancelled ? "Cancelled" : message,
          },
        },
        progressLogByModule: {
          ...s.progressLogByModule,
          [forModule]: [
            ...(s.progressLogByModule[forModule] ?? []),
            cancelled ? "Cancelled." : `Failed: ${message}`,
          ].slice(-40),
        },
      }));
      setButtonLabel(null);
    }
  };

  const resumePendingCreation = useCallback(
    async (
      onProgress: (note: string) => void,
      payload: {
        moduleId: LabModuleId;
        pendingCreationId: string;
        pendingMediaType: "image" | "video";
      },
    ): Promise<LastResult> => {
      const sdk = createAuthedSdk();
      const id = payload.pendingCreationId;
      onProgress(`Resuming wait for ${id}…`);
      setPendingCreation(payload.moduleId, id, payload.pendingMediaType);
      const done = await sdk.waitForCreation(id, {
        onTick: (row) =>
          onProgress(`Waiting for ${id} (${row.status || "…" }).`),
      });
      setPendingCreation(payload.moduleId, null, null);
      if (String(done.status).toLowerCase() === "failed") {
        throw new Error(`Creation failed (${done.id})`);
      }
      onProgress("Syncing to local Library…");
      const creationId = await ingestRemoteCreation(done);
      onProgress(
        payload.pendingMediaType === "image"
          ? "Grouping image into Images…"
          : "Grouping video into Videos…",
      );
      const filed = await fileCreationIntoProjectGroup({
        creationId,
        mediaType: payload.pendingMediaType,
        projectId: project.id,
        projectTitle: project.title,
        imagesGroupId: project.imagesGroupId,
        videosGroupId: project.videosGroupId,
      });
      addCreationsToOpenProject(filed.projectCreationIds);
      if (filed.groupId) {
        setOpenProjectGroupIds(
          payload.pendingMediaType === "image"
            ? { imagesGroupId: filed.groupId }
            : { videosGroupId: filed.groupId },
        );
      }
      onProgress("Added to project.");
      return {
        summary: `Created ${creationId} (${done.status})`,
        detail: filed.message,
        creationId,
        json: { done, filed, resumed: true },
      };
    },
    [
      addCreationsToOpenProject,
      project.imagesGroupId,
      project.title,
      project.videosGroupId,
      setOpenProjectGroupIds,
      setPendingCreation,
    ],
  );

  const applyEnsureCheckpoint = useCallback(
    (state: EnsureCheckpoint) => {
      if (state.backendJobId) {
        ensureBackendJobIdRef.current = state.backendJobId;
      }
      if (
        state.imagesGroupId !== undefined ||
        state.videosGroupId !== undefined
      ) {
        setOpenProjectGroupIds({
          ...(state.imagesGroupId !== undefined
            ? { imagesGroupId: state.imagesGroupId }
            : {}),
          ...(state.videosGroupId !== undefined
            ? { videosGroupId: state.videosGroupId }
            : {}),
        });
      }
      if (state.projectCreationIds && state.projectCreationIds.length > 0) {
        addCreationsToOpenProject(state.projectCreationIds);
      }
      setSession((s) => ({
        ...s,
        activeJob: s.activeJob
          ? {
              ...s.activeJob,
              backendJobId:
                state.backendJobId !== undefined
                  ? state.backendJobId
                  : s.activeJob.backendJobId,
              pendingCreationId:
                state.pendingCreationId !== undefined
                  ? state.pendingCreationId
                  : s.activeJob.pendingCreationId,
              imagesGroupId:
                state.imagesGroupId !== undefined
                  ? state.imagesGroupId
                  : s.activeJob.imagesGroupId,
              videosGroupId:
                state.videosGroupId !== undefined
                  ? state.videosGroupId
                  : s.activeJob.videosGroupId,
            }
          : s.activeJob,
      }));
    },
    [addCreationsToOpenProject, setOpenProjectGroupIds],
  );

  const runEnsureGroups = useCallback(
    async (
      onProgress: (note: string) => void,
      overrides?: {
        backendJobId?: string | null;
        pendingCreationId?: string | null;
        imagesGroupId?: string | null;
        videosGroupId?: string | null;
      },
    ): Promise<LastResult> => {
      // Replace a prior FE watcher; cancel its backend job only when starting fresh
      // (resume passes backendJobId and should attach, not kill).
      const priorJobId = ensureBackendJobIdRef.current;
      ensureAbortRef.current?.abort();
      const ac = new AbortController();
      ensureAbortRef.current = ac;
      setEnsureCancellable(true);
      const backendJobId =
        overrides?.backendJobId !== undefined
          ? overrides.backendJobId
          : (session.activeJob?.backendJobId ?? null);
      if (priorJobId && priorJobId !== backendJobId) {
        void cancelProjectGroupsJob(priorJobId);
      }
      const pendingCreationId =
        overrides?.pendingCreationId !== undefined
          ? overrides.pendingCreationId
          : (session.activeJob?.pendingCreationId ?? null);
      try {
        const result = await ensureProjectGroups({
          projectId: project.id,
          projectTitle: project.title,
          aspectRatio: project.aspectRatio,
          imagesGroupId:
            overrides?.imagesGroupId !== undefined
              ? overrides.imagesGroupId
              : (session.activeJob?.imagesGroupId ?? project.imagesGroupId),
          videosGroupId:
            overrides?.videosGroupId !== undefined
              ? overrides.videosGroupId
              : (session.activeJob?.videosGroupId ?? project.videosGroupId),
          pendingCreationId,
          backendJobId,
          signal: ac.signal,
          onProgress,
          onCheckpoint: applyEnsureCheckpoint,
        });
        ensureBackendJobIdRef.current = result.jobId;
        setOpenProjectGroupIds({
          imagesGroupId: result.imagesGroupId,
          videosGroupId: result.videosGroupId,
        });
        if (result.projectCreationIds.length > 0) {
          addCreationsToOpenProject(result.projectCreationIds);
          onProgress(
            `Added ${result.projectCreationIds.length} group cover(s) to project.`,
          );
        }
        if (!result.imagesGroupId || !result.videosGroupId) {
          throw new Error(
            [
              result.messages.join("\n"),
              `Images group: ${result.imagesGroupId ?? "missing"}`,
              `Videos group: ${result.videosGroupId ?? "missing"}`,
            ]
              .filter(Boolean)
              .join("\n") || "Images and Videos groups are both required",
          );
        }
        return {
          summary: `Groups ready — Images ${result.imagesGroupId}, Videos ${result.videosGroupId}`,
          detail: result.messages.join("\n"),
          json: result,
        };
      } finally {
        setEnsureCancellable(false);
        if (ensureAbortRef.current === ac) ensureAbortRef.current = null;
      }
    },
    [
      addCreationsToOpenProject,
      applyEnsureCheckpoint,
      project.aspectRatio,
      project.id,
      project.imagesGroupId,
      project.title,
      project.videosGroupId,
      session.activeJob?.backendJobId,
      session.activeJob?.imagesGroupId,
      session.activeJob?.pendingCreationId,
      session.activeJob?.videosGroupId,
      setOpenProjectGroupIds,
    ],
  );

  const cancelEnsureGroups = useCallback(() => {
    const jobId =
      ensureBackendJobIdRef.current ||
      session.activeJob?.backendJobId ||
      null;
    // Cancel backend only — watchJob observes `cancelled` and surfaces Cancelled.
    // Do not abort the FE signal here (abort means "detached / left Lab").
    void cancelProjectGroupsJob(jobId);
  }, [session.activeJob?.backendJobId]);

  const runCleanupGroups = useCallback(
    async (onProgress: (note: string) => void): Promise<LastResult> => {
      const imagesGroupId =
        session.activeJob?.imagesGroupId ?? project.imagesGroupId;
      const videosGroupId =
        session.activeJob?.videosGroupId ?? project.videosGroupId;
      const pendingCreationId =
        session.activeJob?.pendingCreationId ?? null;
      if (!imagesGroupId && !videosGroupId && !pendingCreationId) {
        throw new Error("No Images/Videos groups to clean up.");
      }
      const result = await cleanupProjectGroups({
        projectId: project.id,
        imagesGroupId,
        videosGroupId,
        pendingCreationId,
        onProgress,
      });
      // Always strip group covers / pending / remotely deleted members from the
      // open project — even when Parascene delete failed — so Editor assets clear.
      const projectIdsToRemove = [
        ...new Set(
          [
            imagesGroupId,
            videosGroupId,
            pendingCreationId,
            ...result.deletedIds,
          ]
            .map((id) => (id == null ? "" : String(id).trim()))
            .filter(Boolean),
        ),
      ];
      if (projectIdsToRemove.length > 0) {
        removeCreationsFromOpenProject(projectIdsToRemove);
        onProgress(
          `Removed ${projectIdsToRemove.length} asset(s) from the project.`,
        );
      }
      for (const id of result.deletedIds) {
        try {
          await deleteLocal(id);
        } catch {
          /* local row may already be gone */
        }
      }
      setOpenProjectGroupIds({
        imagesGroupId: null,
        videosGroupId: null,
      });
      setSession((s) => {
        const moduleProgress = { ...s.moduleProgress };
        // Downstream Lab steps need groups again — clear stale ok/fail badges.
        for (const id of ["create", "mutate", "a2v"] as const) {
          delete moduleProgress[id];
        }
        const lastByModule = { ...s.lastByModule };
        const progressLogByModule = { ...s.progressLogByModule };
        for (const id of ["create", "mutate", "a2v"] as const) {
          delete lastByModule[id];
          delete progressLogByModule[id];
        }
        return {
          ...s,
          activeJob: null,
          moduleProgress,
          lastByModule,
          progressLogByModule,
        };
      });
      onProgress("Cleared project group ids.");
      return {
        summary:
          result.deletedIds.length > 0
            ? `Cleaned up ${result.deletedIds.length} creation(s)`
            : "Cleanup finished (nothing deleted remotely)",
        detail: result.messages.join("\n"),
      };
    },
    [
      project.id,
      project.imagesGroupId,
      project.videosGroupId,
      removeCreationsFromOpenProject,
      session.activeJob?.imagesGroupId,
      session.activeJob?.pendingCreationId,
      session.activeJob?.videosGroupId,
      setOpenProjectGroupIds,
    ],
  );

  // Auto-resume Ensure after returning to Lab mid-run.
  useEffect(() => {
    if (!resumeGroupsRef.current) return;
    resumeGroupsRef.current = false;
    const payload = resumeEnsurePayloadRef.current;
    resumeEnsurePayloadRef.current = null;
    void run(
      "groups",
      async ({ onProgress }) =>
        runEnsureGroups(onProgress, payload ?? undefined),
      { keepProgressLog: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot resume per project load
  }, [project.id, runEnsureGroups]);

  // Auto-resume create / mutate / a2v waits after leaving Lab mid-poll.
  useEffect(() => {
    const payload = resumePendingRef.current;
    if (!payload) return;
    resumePendingRef.current = null;
    void run(
      payload.moduleId,
      async ({ onProgress }) => resumePendingCreation(onProgress, payload),
      { keepProgressLog: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot resume per project load
  }, [project.id, resumePendingCreation]);

  return (
    <div className="layout lab" aria-label="Lab">
      <aside className="lab-nav" aria-label="Lab modules">
        <h1>Lab</h1>
        <p className="muted lab-project-title">{project.title || "Project"}</p>
        <ul className="lab-module-list">
          {LAB_MODULES.map((m) => {
            const prog = session.moduleProgress[m.id];
            const running = prog?.status === "running";
            const failed = prog?.status === "failed";
            const ok = prog?.status === "ok";
            const gate = labModuleGate(m.id, gateCtx);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className={[
                    "lab-module-btn",
                    moduleId === m.id ? "active" : "",
                    running ? "is-running" : "",
                    failed ? "is-failed" : "",
                    ok ? "is-ok" : "",
                    gate ? "is-blocked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={moduleId === m.id}
                  onClick={() => setModuleId(m.id)}
                >
                  <span className="lab-module-label">
                    {m.label}
                    {running ? "…" : ""}
                  </span>
                  <span className="muted lab-module-blurb">
                    {gate
                      ? gate.navBlurb
                      : running || failed || ok
                        ? prog?.note || m.blurb
                        : m.blurb}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="lab-nav-footer">
          <p className="muted">
            Credits: {credits == null ? "—" : credits}
          </p>
          <button
            type="button"
            className="btn ghost"
            onClick={() => closeProject()}
          >
            Close project
          </button>
        </div>
      </aside>

      <section className="lab-main">
        <header className="lab-main-header">
          <h2>{LAB_MODULES.find((m) => m.id === moduleId)?.label}</h2>
        </header>

        <div className="lab-module-body">
          {moduleId === "groups" && (
            <GroupsModule
              imagesGroupId={
                session.activeJob?.imagesGroupId ?? project.imagesGroupId
              }
              videosGroupId={
                session.activeJob?.videosGroupId ?? project.videosGroupId
              }
              busy={moduleBusy || anyBusy}
              running={ensureCancellable}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.groups}
              onRun={(fn) => void run("groups", fn)}
              onEnsure={runEnsureGroups}
              onCancel={cancelEnsureGroups}
              onCleanup={async (onProgress) => {
                const ok = await confirm({
                  title: "Delete Lab groups?",
                  message:
                    "Deletes the Images and Videos groups and their seed members on Parascene, removes them from this project, and clears local catalog rows. This cannot be undone.",
                  confirmLabel: "Delete / clean up",
                  danger: true,
                });
                if (!ok) throw new Error("Cancelled");
                return runCleanupGroups(onProgress);
              }}
            />
          )}
          {moduleId !== "groups" && activeGate ? (
            <LabGateNotice
              gate={activeGate}
              onGoToGroups={() => setModuleId("groups")}
            />
          ) : null}
          {moduleId === "create" && !activeGate && (
              <CreateModule
                busy={moduleBusy || anyBusy}
                buttonLabel={buttonLabel}
                progressLog={session.progressLogByModule.create}
                onRun={(fn) => void run("create", fn)}
                onCreated={(ids) => addCreationsToOpenProject(ids)}
                imagesGroupId={project.imagesGroupId}
                videosGroupId={project.videosGroupId}
                projectId={project.id}
                projectTitle={project.title}
                aspectRatio={project.aspectRatio}
                onGroups={(ids) => setOpenProjectGroupIds(ids)}
              />
          )}
          {moduleId === "seeds" && !activeGate && (
            <SeedsModule
              assets={assets}
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.seeds}
              onRun={(fn) => void run("seeds", fn)}
            />
          )}
          {moduleId === "isolate" && !activeGate && (
            <IsolateModule
              audioAssets={audioAssets}
              mainAudioId={mainAudioId}
              demucsReady={demucsReady}
              vocalsSlice={session.vocalsSlice}
              onVocalsSliceChange={setVocalsSlice}
              onPickMain={(id) => setOpenProjectMainAudioCreationId(id)}
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.isolate}
              lastResult={session.lastByModule.isolate}
              onRun={(fn) => void run("isolate", fn)}
            />
          )}
          {moduleId === "a2v" && !activeGate && (
              <A2vModule
                imageAssets={imageAssets}
                vocalsSlice={session.vocalsSlice}
                vocalsClip={session.vocalsClip}
                onVocalsClipChange={setVocalsClip}
                onGoToIsolate={() => setModuleId("isolate")}
                busy={moduleBusy || anyBusy}
                buttonLabel={buttonLabel}
                progressLog={session.progressLogByModule.a2v}
                lastResult={session.lastByModule.a2v}
                projectId={project.id}
                projectTitle={project.title}
                aspectRatio={project.aspectRatio}
                imagesGroupId={project.imagesGroupId}
                videosGroupId={project.videosGroupId}
                onRun={(fn) => void run("a2v", fn)}
                onCreated={(ids) => addCreationsToOpenProject(ids)}
                onGroups={(ids) => setOpenProjectGroupIds(ids)}
              />
          )}
          {moduleId === "extend" && !activeGate && (
            <ExtendModule
              videoAssets={videoAssets}
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.extend}
              onRun={(fn) => void run("extend", fn)}
              onCreated={(ids) => addCreationsToOpenProject(ids)}
            />
          )}
          {moduleId === "mutate" && !activeGate && (
              <MutateModule
                imageAssets={imageAssets}
                busy={moduleBusy || anyBusy}
                buttonLabel={buttonLabel}
                progressLog={session.progressLogByModule.mutate}
                projectId={project.id}
                projectTitle={project.title}
                aspectRatio={project.aspectRatio}
                imagesGroupId={project.imagesGroupId}
                videosGroupId={project.videosGroupId}
                onRun={(fn) => void run("mutate", fn)}
                onCreated={(ids) => addCreationsToOpenProject(ids)}
                onGroups={(ids) => setOpenProjectGroupIds(ids)}
              />
          )}
          {moduleId === "openai" && !activeGate && (
            <OpenAiModule
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.openai}
              onRun={(fn) => void run("openai", fn)}
            />
          )}
          {moduleId === "align" && !activeGate && (
            <AlignModule
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.align}
              onRun={(fn) => void run("align", fn)}
            />
          )}
          {moduleId === "propose" && !activeGate && (
            <ProposeModule
              busy={moduleBusy || anyBusy}
              buttonLabel={buttonLabel}
              progressLog={session.progressLogByModule.propose}
              onRun={(fn) => void run("propose", fn)}
            />
          )}
        </div>

        {(() => {
          const last = session.lastByModule[moduleId];
          // Never show leftover output on a gated screen.
          if (!last || activeGate) return null;
          return (
            <footer className="lab-last-result" aria-label="Last result">
              <h3>Last result</h3>
              <p>{last.summary}</p>
              {last.detail && <pre className="lab-pre">{last.detail}</pre>}
              {last.creationId && (
                <p className="muted">Creation id: {last.creationId}</p>
              )}
              {moduleId !== "isolate" && last.playUrl ? (
                <LabResultMedia
                  playUrl={last.playUrl}
                  mediaType={last.playMediaType ?? "audio"}
                />
              ) : null}
              {last.json != null && (
                <pre className="lab-pre lab-json">
                  {JSON.stringify(last.json, null, 2)}
                </pre>
              )}
            </footer>
          );
        })()}
      </section>
    </div>
  );
}

type ModuleChrome = {
  busy: boolean;
  buttonLabel?: string | null;
  progressLog?: string[];
  onRun: Runner;
};

function ProgressLog({ lines }: { lines?: string[] }) {
  if (!lines || lines.length === 0) return null;
  return (
    <ol className="lab-progress-log" aria-label="Progress">
      {lines.map((line, i) => (
        <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
      ))}
    </ol>
  );
}

function LabGateNotice(props: {
  gate: { reason: string; action?: "groups" | "settings" };
  onGoToGroups: () => void;
}) {
  return (
    <div className="lab-form">
      <p className="muted">{props.gate.reason}</p>
      {props.gate.action === "groups" ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => props.onGoToGroups()}
        >
          Go to Project groups
        </button>
      ) : null}
      {props.gate.action === "settings" ? (
        <button
          type="button"
          className="btn primary"
          onClick={() => requestOpenSettings()}
        >
          Open Settings
        </button>
      ) : null}
    </div>
  );
}

function actionLabel(
  busy: boolean,
  buttonLabel: string | null | undefined,
  idle: string,
): string {
  if (!busy) return idle;
  return buttonLabel?.trim() || "Working…";
}

function isolateLastTrack(
  last: LastResult | undefined,
): { path: string; mediaUrl: string } | null {
  if (!last) return null;
  const json = last.json as { path?: string; mediaUrl?: string } | undefined;
  const path = json?.path?.trim() || "";
  if (path) {
    return {
      path,
      mediaUrl:
        json?.mediaUrl?.trim() ||
        last.playUrl?.trim() ||
        convertFileSrc(path),
    };
  }
  if (last.playUrl?.trim()) {
    return null;
  }
  return null;
}

function setStemFromPath(
  path: string,
  setPath: (p: string) => void,
  setUrl: (u: string) => void,
): void {
  setPath(path);
  setUrl(convertFileSrc(path));
}

function GroupsModule(
  props: {
    imagesGroupId: string | null;
    videosGroupId: string | null;
    running: boolean;
    onEnsure: (onProgress: (note: string) => void) => Promise<LastResult>;
    onCancel: () => void;
    onCleanup: (onProgress: (note: string) => void) => Promise<LastResult>;
  } & ModuleChrome,
) {
  const canCleanup = Boolean(
    props.imagesGroupId || props.videosGroupId,
  );
  return (
    <div className="lab-form">
      <p className="muted">
        Images group: {props.imagesGroupId ?? "—"} · Videos group:{" "}
        {props.videosGroupId ?? "—"}
      </p>
      <p className="muted">
        Target state: one image inside the Images group, one video inside the
        Videos group. Fresh runs mint the shared Lab suite still, then animate
        it with image→video (same prompts as later create / mutate / a2v steps).
        On Parascene the group cover is the tile — members live inside the
        group. Uses stored group ids only when they still exist; if you delete
        those groups on Parascene (or use Delete / clean up here), this step
        starts fresh. You can leave mid-run and come back, or Cancel.
      </p>
      <div className="lab-row">
        <button
          type="button"
          className={props.running ? "primary-btn is-busy" : "primary-btn"}
          disabled={props.busy}
          onClick={() =>
            props.onRun(async ({ onProgress }) => props.onEnsure(onProgress))
          }
        >
          {actionLabel(
            props.running,
            props.buttonLabel,
            "Ensure Images + Videos groups",
          )}
        </button>
        {props.running ? (
          <button
            type="button"
            className="btn ghost"
            onClick={() => props.onCancel()}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-danger"
        disabled={props.busy || !canCleanup}
        onClick={() =>
          props.onRun(async ({ onProgress }) => props.onCleanup(onProgress))
        }
      >
        Delete / clean up groups
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function SeedsModule(
  props: { assets: Creation[] } & ModuleChrome,
) {
  return (
    <div className="lab-form">
      <p className="muted">
        Lab uses cloud URLs from synced project assets as create/a2v/mutate
        seeds. Import or sync media in Library, add to this project, then pick
        them in other modules. Local disk upload-to-Parascene can be added here
        later.
      </p>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy}
        onClick={() =>
          props.onRun(async ({ onProgress }) => {
            onProgress("Listing seed URLs…");
            const seeds = props.assets.map((c) => ({
              id: c.id,
              mediaType: c.mediaType,
              localPath: c.localPath,
              remoteUrl: remoteMediaUrl(c),
            }));
            return {
              summary: `${seeds.length} project asset seed(s)`,
              json: seeds,
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "List seed URLs")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function CreateModule(
  props: {
    onCreated: (ids: string[]) => void;
    imagesGroupId: string | null;
    videosGroupId: string | null;
    projectId: string;
    projectTitle: string;
    aspectRatio: string;
    onGroups: (ids: {
      imagesGroupId?: string | null;
      videosGroupId?: string | null;
    }) => void;
  } & ModuleChrome,
) {
  const [kind, setKind] = useState<"image" | "video">("image");
  const [prompt, setPrompt] = useState(LAB_STILL_PROMPT);

  return (
    <div className="lab-form">
      <p className="muted">
        Defaults match the Lab suite prompts (same musician / studio look as
        Project groups). Video create animates the newest still from the Images
        group (same i2v path as Project groups Videos).
      </p>
      <label>
        Kind
        <select
          value={kind}
          onChange={(e) => {
            const next = e.target.value as "image" | "video";
            setKind(next);
            setPrompt(next === "video" ? LAB_ANIMATE_PROMPT : LAB_STILL_PROMPT);
          }}
        >
          <option value="image">Image (Replicate)</option>
          <option value="video">Image→video (LTX i2v)</option>
        </select>
      </label>
      {kind === "video" ? (
        <p className="muted">
          Starting still: newest member of Images{" "}
          {props.imagesGroupId ? `(${props.imagesGroupId})` : "(not ready)"}.
        </p>
      ) : null}
      <label>
        Prompt
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={
          props.busy ||
          !prompt.trim() ||
          (kind === "video" && !props.imagesGroupId)
        }
        onClick={() =>
          props.onRun(async ({ onProgress, onPendingCreation }) => {
            const sdk = createAuthedSdk();
            const token = newCreationToken();
            const mediaType: "image" | "video" =
              kind === "video" ? "video" : "image";
            onProgress(
              kind === "image"
                ? "Starting image create…"
                : "Resolving latest Images group still…",
            );
            const started =
              kind === "image"
                ? await sdk.create({
                    serverId: 1,
                    method: "replicate",
                    creationToken: token,
                    args: {
                      prompt: prompt.trim(),
                      model: "xai/grok-imagine-image",
                      aspect_ratio: props.aspectRatio,
                    },
                  })
                : await (async () => {
                    const still = await resolveLatestImagesGroupStill({
                      imagesGroupId: props.imagesGroupId,
                      sdk,
                    });
                    onProgress(
                      `Animating still ${still.sourceId} (image→video)…`,
                    );
                    return sdk.create({
                      serverId: 6,
                      method: "image2video",
                      creationToken: token,
                      args: {
                        prompt: prompt.trim(),
                        model: "ltx_i2v",
                        aspect_ratio: props.aspectRatio,
                        input_images: [still.imageUrl],
                      },
                    });
                  })();
            onPendingCreation(String(started.id), mediaType);
            onProgress(`Waiting for ${started.id}…`);
            const done = await sdk.waitForCreation(started.id, {
              onTick: (row) =>
                onProgress(`Waiting for ${started.id} (${row.status || "…" }).`),
            });
            onPendingCreation(null, null);
            if (String(done.status).toLowerCase() === "failed") {
              throw new Error(`Creation failed (${done.id})`);
            }
            onProgress("Syncing to local Library…");
            const id = await ingestRemoteCreation(done);
            onProgress(
              mediaType === "image"
                ? "Grouping image into Images…"
                : "Grouping video into Videos…",
            );
            const filed = await fileCreationIntoProjectGroup({
              creationId: id,
              mediaType,
              projectId: props.projectId,
              projectTitle: props.projectTitle,
              imagesGroupId: props.imagesGroupId,
              videosGroupId: props.videosGroupId,
            });
            props.onCreated(filed.projectCreationIds);
            if (filed.groupId) {
              props.onGroups(
                mediaType === "image"
                  ? { imagesGroupId: filed.groupId }
                  : { videosGroupId: filed.groupId },
              );
            }
            onProgress("Added to project.");
            return {
              summary: `Created ${id} (${done.status})`,
              detail: filed.message,
              creationId: id,
              json: { started, done, filed },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Run create")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function IsolateModule(
  props: {
    audioAssets: Creation[];
    mainAudioId: string;
    demucsReady: boolean;
    vocalsSlice: LabVocalsSlice | null;
    onVocalsSliceChange: (slice: LabVocalsSlice | null) => void;
    lastResult?: LastResult;
    onPickMain: (id: string | null) => void;
  } & ModuleChrome,
) {
  const [audioId, setAudioId] = useState(props.mainAudioId);
  const [clipLengthSec, setClipLengthSec] = useState(8);
  const [sliceStartSec, setSliceStartSec] = useState(0);
  const inSec = sliceStartSec;
  const outSec = sliceStartSec + clipLengthSec;
  const [originalPath, setOriginalPath] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [fullVocalsPath, setFullVocalsPath] = useState<string | null>(null);
  const [fullVocalsUrl, setFullVocalsUrl] = useState<string | null>(null);
  const [vocalsSlicePath, setVocalsSlicePath] = useState<string | null>(null);
  const [vocalsSliceUrl, setVocalsSliceUrl] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<"separate" | "slice" | null>(
    null,
  );
  const activeActionRef = useRef<"separate" | "slice" | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    // Intentional: adopt the project's main audio id once it becomes available.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (props.mainAudioId && !audioId) setAudioId(props.mainAudioId);
  }, [props.mainAudioId, audioId]);

  useEffect(() => {
    if (
      props.vocalsSlice?.sourceAudioId &&
      props.vocalsSlice.sourceAudioId !== audioId
    ) {
      props.onVocalsSliceChange(null);
    }
  }, [audioId, props.vocalsSlice?.sourceAudioId, props.onVocalsSliceChange]);

  useEffect(() => {
    if (!props.busy) {
      activeActionRef.current = null;
      // Intentional: clear the active-action label when the run finishes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveAction(null);
      setElapsedSec(0);
    }
  }, [props.busy]);

  useEffect(() => {
    if (!props.busy || activeActionRef.current !== "separate") return;
    setElapsedSec(0);
    const started = Date.now();
    const id = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [props.busy, activeAction]);

  useEffect(() => {
    let cancelled = false;
    if (!audioId) {
      // Intentional: reset derived audio state when the selected asset changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOriginalPath(null);
      setOriginalUrl(null);
      setFullVocalsPath(null);
      setFullVocalsUrl(null);
      setVocalsSlicePath(null);
      setVocalsSliceUrl(null);
      return;
    }

    // Switching assets clears derived slices; vocals re-loaded from cache below.
    setVocalsSlicePath(null);
    setVocalsSliceUrl(null);
    setFullVocalsPath(null);
    setFullVocalsUrl(null);
    setSliceStartSec(0);

    void getCreations([audioId]).then(async (rows) => {
      if (cancelled) return;
      const row = rows[0];
      const path = row?.localPath?.trim() || null;
      setOriginalPath(path);
      setOriginalUrl(path ? convertFileSrc(path) : null);

      if (path) {
        try {
          const cached = await cachedFullVocalsPath(path);
          if (!cancelled && cached) {
            setStemFromPath(cached, setFullVocalsPath, setFullVocalsUrl);
          }
        } catch {
          /* no cached stem yet */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [audioId]);

  // Restore inline player after remount from last successful separate/slice.
  useEffect(() => {
    const track = isolateLastTrack(props.lastResult);
    if (!track?.path) return;
    if (track.path.includes(".full-vocals.")) {
      setStemFromPath(track.path, setFullVocalsPath, setFullVocalsUrl);
    } else if (track.path.includes(".slice.")) {
      setStemFromPath(track.path, setVocalsSlicePath, setVocalsSliceUrl);
    }
  }, [props.lastResult]);

  useEffect(() => {
    const slice = props.vocalsSlice;
    if (!slice?.path) return;
    if (slice.sourceAudioId && audioId && slice.sourceAudioId !== audioId) return;
    setStemFromPath(slice.path, setVocalsSlicePath, setVocalsSliceUrl);
    // Intentional: sync the slice window controls to the restored slice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSliceStartSec(slice.inSec);
    setClipLengthSec(Math.max(0.1, slice.outSec - slice.inSec));
  }, [props.vocalsSlice, audioId]);

  // Prefer ref so the busy label is correct on the first paint after click
  // (setState for activeAction can lag one frame behind moduleBusy).
  /* eslint-disable react-hooks/refs */
  const separateBusy =
    props.busy &&
    (activeActionRef.current === "separate" || activeAction === "separate");
  const sliceBusy =
    props.busy &&
    (activeActionRef.current === "slice" || activeAction === "slice");
  /* eslint-enable react-hooks/refs */

  const separateLabel = separateBusy
    ? elapsedSec > 0
      ? `Separating full-track vocals (demucs)… ${elapsedSec}s`
      : props.buttonLabel?.trim() ||
        "Separating full-track vocals (demucs)…"
    : "Separate full vocals";

  return (
    <div className="lab-form lab-isolate">
      <p className="muted">
        Product path: separate <strong>full-track</strong> vocals once (Demucs),
        then slice a range from the vocals stem.
      </p>
      {!props.demucsReady ? (
        <p className="muted">
          Demucs is not installed — vocals separate and slice are disabled.
          Install from{" "}
          <button
            type="button"
            className="lab-inline-link"
            onClick={() => requestOpenSettings()}
          >
            Settings → Local tools
          </button>{" "}
          (see <code>LOCAL_TOOLS.md</code>).
        </p>
      ) : null}

      <section className="lab-isolate-section">
        <h4 className="lab-isolate-section-title">1. Source</h4>
        <label>
          Audio asset
          <select
            value={audioId}
            onChange={(e) => {
              setAudioId(e.target.value);
              props.onPickMain(e.target.value || null);
            }}
          >
            <option value="">Select…</option>
            {props.audioAssets.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.id}
              </option>
            ))}
          </select>
        </label>
        <LabAudioTrack
          label="Full mix"
          path={originalPath}
          mediaUrl={originalUrl}
          hint="Source asset on disk"
        />
      </section>

      <section className="lab-isolate-section">
        <h4 className="lab-isolate-section-title">2. Vocals stem</h4>
        <button
          type="button"
          className={separateBusy ? "primary-btn is-busy" : "primary-btn"}
          disabled={props.busy || !originalPath || !props.demucsReady}
          onClick={() => {
            activeActionRef.current = "separate";
            setActiveAction("separate");
            props.onRun(async ({ onProgress }) => {
              if (!originalPath) throw new Error("No local audio path");
              props.onPickMain(audioId || null);
              onProgress("Separating full-track vocals (demucs)…");
              const full = await separateFullVocals({ sourcePath: originalPath });
              setStemFromPath(full.path, setFullVocalsPath, setFullVocalsUrl);
              onProgress("Full vocals stem ready (cached for re-runs).");
              return {
                summary: `Full vocals: ${full.path}`,
                detail: full.note,
                json: full,
              };
            });
          }}
        >
          {separateBusy ? separateLabel : "Separate full vocals"}
        </button>
        <LabAudioTrack
          label="Full vocals stem"
          path={fullVocalsPath}
          mediaUrl={fullVocalsUrl}
          hint="Kept for the project session / Lab cache"
        />
      </section>

      <section className="lab-isolate-section">
        <h4 className="lab-isolate-section-title">3. Slice</h4>
        <label>
          Clip length (sec)
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={clipLengthSec}
            onChange={(e) => {
              const next = Math.max(0.1, Number(e.target.value) || 0.1);
              setClipLengthSec(next);
            }}
          />
        </label>
        {fullVocalsPath && fullVocalsUrl ? (
          <LabWaveformSlicePicker
            path={fullVocalsPath}
            mediaUrl={fullVocalsUrl}
            clipLengthSec={clipLengthSec}
            startSec={sliceStartSec}
            onStartChange={setSliceStartSec}
          />
        ) : (
          <p className="muted">
            {originalPath
              ? "Separate full vocals in step 2 to pick a slice on the vocals stem."
              : "Select an audio asset, then separate vocals to choose a slice."}
          </p>
        )}
        <button
          type="button"
          className={sliceBusy ? "primary-btn is-busy" : "primary-btn"}
          disabled={
            props.busy ||
            !fullVocalsPath ||
            !(clipLengthSec > 0) ||
            !(outSec > inSec)
          }
          onClick={() => {
            activeActionRef.current = "slice";
            setActiveAction("slice");
            props.onRun(async ({ onProgress }) => {
              if (!fullVocalsPath) {
                throw new Error("Separate full vocals before slicing");
              }
              props.onPickMain(audioId || null);
              onProgress("Slicing vocals stem…");
              const vocals = await sliceAudioRange({
                sourcePath: fullVocalsPath,
                inSec,
                outSec,
              });
              setStemFromPath(vocals.path, setVocalsSlicePath, setVocalsSliceUrl);
              props.onVocalsSliceChange({
                path: vocals.path,
                inSec,
                outSec,
                sourceAudioId: audioId,
                slicedAt: new Date().toISOString(),
              });

              return {
                summary: `Vocals slice ${inSec}–${outSec}s`,
                detail: vocals.note,
                json: { vocals, inSec, outSec },
              };
            });
          }}
        >
          {actionLabel(sliceBusy, props.buttonLabel, "Slice vocals")}
        </button>
        <LabAudioTrack
          label="Sliced vocals"
          path={vocalsSlicePath}
          mediaUrl={vocalsSliceUrl}
          hint={`${inSec}–${outSec}s from full vocals stem`}
        />
      </section>

      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function A2vModule(
  props: {
    imageAssets: Creation[];
    vocalsSlice: LabVocalsSlice | null;
    vocalsClip: LabVocalsClip | null;
    onVocalsClipChange: (clip: LabVocalsClip | null) => void;
    onGoToIsolate: () => void;
    lastResult?: LastResult;
    projectId: string;
    projectTitle: string;
    aspectRatio: string;
    imagesGroupId: string | null;
    videosGroupId: string | null;
    onCreated: (ids: string[]) => void;
    onGroups: (ids: {
      imagesGroupId?: string | null;
      videosGroupId?: string | null;
    }) => void;
  } & ModuleChrome,
) {
  const [imageId, setImageId] = useState(props.imageAssets[0]?.id || "");
  const [prompt, setPrompt] = useState(LAB_A2V_PROMPT);
  const [clipBusy, setClipBusy] = useState(false);
  const [clipError, setClipError] = useState<string | null>(null);
  const vocalsSliceUrl = props.vocalsSlice?.path
    ? convertFileSrc(props.vocalsSlice.path)
    : null;
  const clipReady = vocalsClipMatchesSlice(props.vocalsClip, props.vocalsSlice);
  const staleClip = Boolean(props.vocalsClip) && !clipReady;

  useEffect(() => {
    // Intentional: keep the selected still valid as the image list changes.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!props.imageAssets.length) {
      setImageId("");
      return;
    }
    if (!props.imageAssets.some((c) => c.id === imageId)) {
      setImageId(props.imageAssets[0]!.id);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [props.imageAssets, imageId]);

  const handleUploadClip = async () => {
    const slice = props.vocalsSlice;
    if (!slice?.path || clipBusy) return;
    setClipBusy(true);
    setClipError(null);
    try {
      const durationSec = Math.max(0.1, slice.outSec - slice.inSec);
      const { clipId, audioUrl } = await uploadVocalsSliceClip(slice.path, {
        title: `Lab vocals ${slice.inSec}–${slice.outSec}s`,
        durationSec,
      });
      props.onVocalsClipChange({
        clipId,
        audioUrl,
        slicePath: slice.path,
        inSec: slice.inSec,
        outSec: slice.outSec,
        sourceAudioId: slice.sourceAudioId,
        uploadedAt: new Date().toISOString(),
      });
    } catch (err) {
      setClipError(err instanceof Error ? err.message : String(err));
    } finally {
      setClipBusy(false);
    }
  };

  const handleRemoveClip = async () => {
    const clip = props.vocalsClip;
    if (!clip || clipBusy) return;
    setClipBusy(true);
    setClipError(null);
    try {
      await deleteAudioClip(clip.clipId);
      props.onVocalsClipChange(null);
    } catch (err) {
      setClipError(err instanceof Error ? err.message : String(err));
    } finally {
      setClipBusy(false);
    }
  };

  return (
    <div className="lab-form">
      <p className="muted">
        Uses Parascene Blue <code>audio2video</code> / <code>ltx_a2v</code> with
        the shared Lab suite performance prompt. Requires a vocals slice from{" "}
        <strong>Vocals / slice</strong>, then upload it as a clip so the
        generator can fetch a public audio URL.
      </p>
      <div className="lab-image-picker-field">
        <span className="lab-image-picker-heading">Still</span>
        <LabImagePicker
          images={props.imageAssets}
          value={imageId}
          onChange={setImageId}
        />
      </div>
      {props.vocalsSlice ? (
        <>
          <LabAudioTrack
            label="Vocals slice (from Vocals / slice)"
            path={props.vocalsSlice.path}
            mediaUrl={vocalsSliceUrl}
            hint={`${props.vocalsSlice.inSec}–${props.vocalsSlice.outSec}s`}
          />
          <div className="lab-a2v-clip">
            {clipReady ? (
              <div className="lab-a2v-clip-ready">
                <span className="lab-a2v-clip-status">
                  Clip uploaded — public audio URL ready (id {props.vocalsClip!.clipId})
                </span>
                <button
                  type="button"
                  className="lab-secondary-btn"
                  disabled={clipBusy}
                  onClick={() => void handleRemoveClip()}
                >
                  {clipBusy ? "Removing…" : "Remove clip"}
                </button>
              </div>
            ) : (
              <div className="lab-a2v-clip-actions">
                <button
                  type="button"
                  className="lab-secondary-btn"
                  disabled={clipBusy || !props.vocalsSlice.path}
                  onClick={() => void handleUploadClip()}
                >
                  {clipBusy ? "Uploading clip…" : "Upload clip for a2v"}
                </button>
                {staleClip ? (
                  <button
                    type="button"
                    className="lab-secondary-btn"
                    disabled={clipBusy}
                    onClick={() => void handleRemoveClip()}
                  >
                    {clipBusy ? "Removing…" : "Remove old clip"}
                  </button>
                ) : null}
                <span className="lab-a2v-clip-status muted">
                  {staleClip
                    ? "Slice changed since upload — upload a fresh clip to run a2v."
                    : "Upload the slice to unlock Run a2v."}
                </span>
              </div>
            )}
            {clipError ? (
              <p className="lab-a2v-clip-error">{clipError}</p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="muted">
          No vocals slice yet.{" "}
          <button
            type="button"
            className="lab-inline-link"
            onClick={() => props.onGoToIsolate()}
          >
            Go to Vocals / slice
          </button>{" "}
          to separate vocals and slice a range.
        </p>
      )}
      <label>
        Prompt
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy || !imageId || !clipReady}
        onClick={() =>
          props.onRun(async ({ onProgress, onPendingCreation }) => {
            const slice = props.vocalsSlice;
            if (!slice?.path) {
              throw new Error("Slice vocals in Vocals / slice before running a2v");
            }
            const clip = props.vocalsClip;
            if (!clip || !vocalsClipMatchesSlice(clip, slice)) {
              throw new Error("Upload the vocals clip before running a2v");
            }
            const img = (await getCreations([imageId]))[0];
            if (!img) throw new Error("Still not found");
            const imageUrl = remoteMediaUrl(img);
            if (!imageUrl) {
              throw new Error(
                "Still has no remote URL — sync a cloud image into the project",
              );
            }
            onProgress("Starting a2v…");
            const sdk = createAuthedSdk();
            const started = await sdk.create({
              serverId: 6,
              method: "audio2video",
              creationToken: newCreationToken(),
              args: {
                prompt: prompt.trim(),
                model: "ltx_a2v",
                aspect_ratio: props.aspectRatio,
                input_images: [imageUrl],
                audio_clip_id: Number(clip.clipId),
              },
            });
            onPendingCreation(String(started.id), "video");
            onProgress(`Waiting for ${started.id}…`);
            const done = await sdk.waitForCreation(started.id, {
              onTick: (row) =>
                onProgress(`Waiting for ${started.id} (${row.status || "…" }).`),
            });
            onPendingCreation(null, null);
            if (String(done.status).toLowerCase() === "failed") {
              throw new Error(`a2v failed (${done.id})`);
            }
            onProgress("Syncing to local Library…");
            const id = await ingestRemoteCreation(done);
            onProgress("Grouping video…");
            const filed = await fileCreationIntoProjectGroup({
              creationId: id,
              mediaType: "video",
              projectId: props.projectId,
              projectTitle: props.projectTitle,
              imagesGroupId: props.imagesGroupId,
              videosGroupId: props.videosGroupId,
            });
            props.onCreated(filed.projectCreationIds);
            if (filed.groupId) {
              props.onGroups({ videosGroupId: filed.groupId });
            }
            onProgress("Added to project.");
            const [created] = await getCreations([id]);
            const playUrl = creationPlayUrl(created) ?? undefined;
            return {
              summary: `a2v ${id}`,
              detail: `Vocals slice ${slice.inSec}–${slice.outSec}s\n${filed.message}`,
              creationId: id,
              playUrl,
              playMediaType: "video",
              json: { slice, clip, started, done, filed },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Run a2v")}
      </button>
      {props.lastResult?.playUrl &&
      props.lastResult.playMediaType === "video" ? (
        <div className="lab-a2v-result">
          <h4 className="lab-isolate-section-title">Latest clip</h4>
          <LabResultMedia
            playUrl={props.lastResult.playUrl}
            mediaType="video"
          />
        </div>
      ) : null}
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function ExtendModule(
  props: {
    videoAssets: Creation[];
    onCreated: (ids: string[]) => void;
  } & ModuleChrome,
) {
  const [videoId, setVideoId] = useState(props.videoAssets[0]?.id || "");
  const [pingPong, setPingPong] = useState(true);
  const [targetSec, setTargetSec] = useState(18);
  const [inSec, setInSec] = useState(0);
  const [outSec, setOutSec] = useState(0);
  const [previewCreation, setPreviewCreation] = useState<Creation | null>(null);

  useEffect(() => {
    // Intentional: keep the selected video valid as the asset list changes.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!props.videoAssets.length) {
      setVideoId("");
      return;
    }
    if (!props.videoAssets.some((c) => c.id === videoId)) {
      setVideoId(props.videoAssets[0]!.id);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [props.videoAssets, videoId]);

  const handleVideoChange = useCallback((id: string) => {
    setVideoId(id);
    setInSec(0);
    setOutSec(0);
  }, []);

  const selectedVideo = props.videoAssets.find((c) => c.id === videoId);
  const videoPlayUrl = selectedVideo
    ? creationPlayUrl(selectedVideo)
    : null;

  const handleRangeChange = useCallback(
    (next: { inSec: number; outSec: number }) => {
      setInSec(next.inSec);
      setOutSec(next.outSec);
    },
    [],
  );

  return (
    <div className="lab-form">
      <p className="muted">
        Pick a video, trim a region with the handles (or Start / End fields),
        preview that region on loop, then bake to a target length.
      </p>
      <div className="lab-image-picker-field">
        <span className="lab-image-picker-heading">Video</span>
        <LabImagePicker
          images={props.videoAssets}
          value={videoId}
          onChange={handleVideoChange}
          onPreview={setPreviewCreation}
          mediaLabel="videos"
        />
      </div>
      {previewCreation ? (
        <CreationLightbox
          creation={previewCreation}
          onClose={() => setPreviewCreation(null)}
        />
      ) : null}
      {videoId && videoPlayUrl ? (
        <div className="lab-image-picker-field">
          <span className="lab-image-picker-heading">Region</span>
          <LabVideoRangePicker
            mediaUrl={videoPlayUrl}
            inSec={inSec}
            outSec={outSec}
            onRangeChange={handleRangeChange}
          />
        </div>
      ) : videoId ? (
        <p className="muted">
          Selected video has no local file yet — sync / download it before
          trimming.
        </p>
      ) : null}
      <label className="lab-checkbox-row">
        <input
          type="checkbox"
          checked={pingPong}
          onChange={(e) => setPingPong(e.target.checked)}
        />
        Ping-pong (play forward then reversed between loops)
      </label>
      <label>
        Target seconds
        <input
          type="number"
          step="0.1"
          value={targetSec}
          onChange={(e) => setTargetSec(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy || !videoId || !(outSec > inSec)}
        onClick={() =>
          props.onRun(async ({ onProgress }) => {
            onProgress("Baking extend…");
            const rows = await getCreations([videoId]);
            const row = rows[0];
            if (!row?.localPath) {
              throw new Error("Video has no local path");
            }
            const baked = await bakeClipExtend({
              sourcePath: row.localPath,
              pingPong,
              targetSec,
              inSec,
              outSec,
            });
            onProgress("Importing to Library (local-only)…");
            const imported = await importLocalPaths([baked.path]);
            const created = imported.creations[0];
            if (!created) {
              throw new Error("Import produced no Library creation");
            }
            props.onCreated([created.id]);
            onProgress("Added to project assets.");
            const playUrl = creationPlayUrl(created) ?? baked.mediaUrl;
            return {
              summary: `Extended → ${created.id} (local-only)`,
              detail: `${pingPong ? "ping-pong" : "loop"} ${inSec.toFixed(2)}–${outSec.toFixed(2)}s → ${targetSec}s`,
              creationId: created.id,
              playUrl,
              playMediaType: "video",
              json: { baked, imported: created, inSec, outSec, pingPong, targetSec },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Bake extend")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function MutateModule(
  props: {
    imageAssets: Creation[];
    projectId: string;
    projectTitle: string;
    aspectRatio: string;
    imagesGroupId: string | null;
    videosGroupId: string | null;
    onCreated: (ids: string[]) => void;
    onGroups: (ids: {
      imagesGroupId?: string | null;
      videosGroupId?: string | null;
    }) => void;
  } & ModuleChrome,
) {
  const [imageId, setImageId] = useState(props.imageAssets[0]?.id || "");
  const [prompt, setPrompt] = useState(LAB_MUTATE_PROMPT);

  return (
    <div className="lab-form">
      <p className="muted">
        Default edit keeps the Lab suite musician identity (same as Project
        groups / create).
      </p>
      <label>
        Source image
        <select value={imageId} onChange={(e) => setImageId(e.target.value)}>
          <option value="">Select…</option>
          {props.imageAssets.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || c.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        Edit prompt
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy || !imageId}
        onClick={() =>
          props.onRun(async ({ onProgress, onPendingCreation }) => {
            onProgress("Starting mutate…");
            const rows = await getCreations([imageId]);
            const img = rows[0];
            if (!img) throw new Error("Image not found");
            const imageUrl = remoteMediaUrl(img);
            if (!imageUrl) throw new Error("No remote image URL");
            const mutateOf = Number(imageId);
            const sdk = createAuthedSdk();
            const started = await sdk.create({
              serverId: 1,
              method: "replicate",
              creationToken: newCreationToken(),
              mutateOfId: Number.isFinite(mutateOf) ? mutateOf : undefined,
              args: {
                prompt: prompt.trim(),
                model: "xai/grok-imagine-image",
                input_images: [imageUrl],
                aspect_ratio: props.aspectRatio,
              },
            });
            onPendingCreation(String(started.id), "image");
            onProgress(`Waiting for ${started.id}…`);
            const done = await sdk.waitForCreation(started.id, {
              onTick: (row) =>
                onProgress(`Waiting for ${started.id} (${row.status || "…" }).`),
            });
            onPendingCreation(null, null);
            if (String(done.status).toLowerCase() === "failed") {
              throw new Error(`Mutate failed (${done.id})`);
            }
            onProgress("Syncing to local Library…");
            const id = await ingestRemoteCreation(done);
            onProgress("Grouping image…");
            const filed = await fileCreationIntoProjectGroup({
              creationId: id,
              mediaType: "image",
              projectId: props.projectId,
              projectTitle: props.projectTitle,
              imagesGroupId: props.imagesGroupId,
              videosGroupId: props.videosGroupId,
            });
            props.onCreated(filed.projectCreationIds);
            if (filed.groupId) {
              props.onGroups({ imagesGroupId: filed.groupId });
            }
            onProgress("Added to project.");
            return {
              summary: `Mutated → ${id}`,
              detail: filed.message,
              creationId: id,
              json: { started, done },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Run mutate")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function OpenAiModule(props: ModuleChrome) {
  const [prompt, setPrompt] = useState(
    'Return JSON: {"ok":true,"note":"lab smoke"}',
  );

  return (
    <div className="lab-form">
      <p className="muted">
        Uses the OpenAI API key from Settings (account menu, upper right).
      </p>
      <label>
        User prompt
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy}
        onClick={() =>
          props.onRun(async ({ onProgress }) => {
            const apiKey = loadOpenAiApiKey();
            if (!apiKey) {
              throw new Error(
                "OpenAI API key missing — set it in Settings (account menu).",
              );
            }
            onProgress("Calling OpenAI…");
            const result = await openAiChatCompletion({
              apiKey,
              user: prompt,
              jsonMode: true,
              system: "You are a Lab smoke test. Reply with compact JSON only.",
            });
            return {
              summary: "OpenAI ok",
              detail: result.content,
              json: { request: result.request, response: result.response },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Run OpenAI")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function AlignModule(props: ModuleChrome) {
  const [lyrics, setLyrics] = useState(
    "Line one of the song\nLine two keeps going\nLine three for the chorus",
  );
  const [durationSec, setDurationSec] = useState(24);

  return (
    <div className="lab-form">
      <p className="muted">
        Lab placeholder: even-spaced line timings. Replace with forced aligner
        when packaged.
      </p>
      <label>
        Lyrics
        <textarea
          rows={6}
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
        />
      </label>
      <label>
        Song duration (sec)
        <input
          type="number"
          value={durationSec}
          onChange={(e) => setDurationSec(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy}
        onClick={() =>
          props.onRun(async ({ onProgress }) => {
            onProgress("Aligning lines…");
            const lines = lyrics
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            if (lines.length === 0) throw new Error("Paste lyrics");
            const span = durationSec / lines.length;
            const aligned = lines.map((line, i) => ({
              line,
              startSec: Number((i * span).toFixed(3)),
              endSec: Number(((i + 1) * span).toFixed(3)),
            }));
            return {
              summary: `Aligned ${aligned.length} lines (even spacing)`,
              json: { mode: "even_lab_placeholder", aligned },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Align (Lab placeholder)")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

function ProposeModule(props: ModuleChrome) {
  const [lyrics, setLyrics] = useState("We dance until the morning light");
  const [durationSec, setDurationSec] = useState(30);

  return (
    <div className="lab-form">
      <p className="muted">
        Uses the OpenAI API key from Settings (account menu, upper right).
      </p>
      <label>
        Lyrics sample
        <textarea
          rows={4}
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
        />
      </label>
      <label>
        Duration (sec)
        <input
          type="number"
          value={durationSec}
          onChange={(e) => setDurationSec(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className={props.busy ? "primary-btn is-busy" : "primary-btn"}
        disabled={props.busy}
        onClick={() =>
          props.onRun(async ({ onProgress }) => {
            const apiKey = loadOpenAiApiKey();
            if (!apiKey) {
              throw new Error(
                "OpenAI API key missing — set it in Settings (account menu).",
              );
            }
            onProgress("Proposing storyboard…");
            const lines = lyrics
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            const span = durationSec / Math.max(1, lines.length);
            const aligned = lines.map((line, i) => ({
              line,
              start: Number((i * span).toFixed(2)),
              end: Number(((i + 1) * span).toFixed(2)),
            }));
            const user = JSON.stringify(
              {
                durationSec,
                lyrics: aligned,
                shotCatalog: LAB_SHOT_CATALOG,
                constraints: {
                  maxShotSec: 9,
                  preferLipSyncOnVocalLines: true,
                },
                instruction:
                  "Propose music-video scenes as JSON { scenes: [{ startSec, endSec, shotType, note, promptHint }] }. shotType must be from shotCatalog.",
              },
              null,
              2,
            );
            const result = await openAiChatCompletion({
              apiKey,
              jsonMode: true,
              system:
                "You are a music-video director assistant. Reply with JSON only.",
              user,
            });
            return {
              summary: "Storyboard proposal",
              detail: result.content,
              json: { request: result.request, response: result.response },
            };
          })
        }
      >
        {actionLabel(props.busy, props.buttonLabel, "Propose storyboard")}
      </button>
      <ProgressLog lines={props.progressLog} />
    </div>
  );
}
