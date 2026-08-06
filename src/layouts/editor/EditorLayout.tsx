import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { useShell } from "../../app/ShellProvider";
import {
  deleteCompositionRun,
  deleteLocal,
  deleteProjectAsset,
  getCreations,
  getProjectBoundFolder,
  listProjectAssetIds,
  mergeTimelineClips,
  removeProjectAssets,
  setProjectBoundFolder,
  type MergeProgress,
} from "../../library/catalogClient";
import { groupSourceCreationIds } from "../../library/creationFlags";
import {
  addToFolder,
  getFolder,
  listFolders,
  type LibraryFolder,
} from "../../library/folderClient";
import { isBoundFolderLockedByTimeline } from "../../project/projectStore";
import { landCreationsInBoundFolder } from "../../project/boundFolderLanding";
import {
  ensureSlideshowMedia,
  formatBakeError,
  slideshowEnsureInputFromRecipe,
  type BakeInfo,
} from "../../library/slideshowMedia";
import { bakeClipExtend, deleteExtendCacheFile } from "../../lab/audioTools";
import { getCreation } from "../../library/catalogClient";
import { AssetBrowserPane, type AssetKindFilter } from "./AssetBrowserPane";
import { AssistantPane } from "./AssistantPane";
import {
  ASSISTANT_COLLAPSED_STRIP,
  clampAssetsWidth,
  clampAssistantWidth,
  clampTimelineHeight,
  loadEditorLayoutPrefs,
  saveEditorLayoutPrefs,
  type EditorLayoutPrefs,
} from "./editorLayoutPrefs";
import { PreviewPane } from "./PreviewPane";
import { findOverlappingAudioClip } from "./audioOverlap";
import { pasteAppendStartSec } from "./timelineAppend";
import {
  selectionFromProject,
  pendingDraftMatchesSelection,
} from "./editorSelection";
import type { StartAddAssetGenerationRequest } from "./AddAssetGeneratePanel";
import type { AddAssetIntent } from "./previewIntent";
import {
  clearAddAssetGenerationError,
  clearAddAssetGenerationIfClipMissing,
  retryAddAssetDownloadJob,
  startAddAssetGenerationJob,
  useAddAssetGenerationSession,
} from "./addAssetGenerationStore";
import { findTimelineGenerationForAsset } from "./addAssetGenerate";
import { isDownloadRetryableError } from "./addAssetReplicateGenerate";
import { resolveEditorMainAudioCreationId } from "./addAssetStartFrame";
import { replicatePredictionsList } from "../../replicate/replicateClient";
import {
  addAssetClipDurationSec,
  ADD_ASSET_TIMELINE_DURATION_SEC,
  applyDraftToTimelineClip,
  isAddAssetPlaceholderClip,
  newSlideshowSeed,
  slideshowRecipesEqual,
  stagedDraftForDuplicateGenerate,
  timelineClipToStagedDraft,
  withAddAssetDuration,
  type StagedClipDraft,
} from "./stagedClip";
import {
  installEditorGestureSafetyNet,
  releasePointerCaptureSafe,
  subscribeGestureAbort,
} from "./gestureCleanup";
import { registerGestureStatusProvider } from "../../app/uiDiagnostics";
import { recordUiOpTrace } from "./uiOpTrace";
import { TimelinePane } from "./TimelinePane";
import {
  clipInSec,
  clipOutSec,
  timelineSequenceDuration,
} from "./timelineCompose";
import {
  clipHasFreshExtendBake,
  clipNeedsExtendBake,
  computeExtendBakeKey,
  computeExtendBakeTargetSec,
} from "./clipExtendBake";
import { getMergeableTimelineSelection } from "./timelineMerge";
import {
  getJoinableTimelinePair,
  joinReplacementSpan,
  type JoinStudioParams,
} from "./joinStudio";
import { JoinStudioModal } from "./JoinStudioModal";
import {
  TimelineMergeModal,
  type TimelineMergeModalState,
} from "./TimelineMergeModal";
import {
  isBeatSlideshowMode,
  type AddAssetGeneration,
  type TimelineClip,
} from "../../project/types";
import { useConfirm } from "../../ui/ConfirmDialog";
import {
  removeMembersFromProjectGroup,
  type ProjectGroupKind,
} from "../../lab/projectGroups";

const NARROW_MQ = "(max-width: 1100px)";

function matchesNarrowViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(NARROW_MQ).matches;
}

function newTimelineClipId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatClipDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.0s";
  return `${(Math.round(sec * 10) / 10).toFixed(1)}s`;
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** Fields and controls that should keep Space for their own behavior. */
function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    tag === "A" ||
    target.isContentEditable
  );
}

type DragKind = "assets" | "assistant" | "timeline";

type DragState = {
  kind: DragKind;
  startX: number;
  startY: number;
  startAssets: number;
  startAssistant: number;
  startTimeline: number;
  reservedRight: number;
  reservedLeft: number;
};

export function EditorLayout() {
  const {
    project,
    addCreationsToOpenProject,
    removeCreationsFromOpenProject,
    removeFoldersFromOpenProject,
    setOpenProjectBoundFolderId,
    setOpenProjectGroupIds,
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
    setOpenProjectSelectedAssetId,
    selectCreationsOnOpenProject,
    setOpenProjectPendingStagedDraft,
    setOpenProjectTimelineZoom,
    setOpenProjectTimelineMonitorActive,
    setOpenProjectTimelinePlayheadSec,
    removeOpenStillWorkstream,
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
  } = useShell();
  const confirm = useConfirm();

  const [prefs, setPrefs] = useState<EditorLayoutPrefs>(() =>
    loadEditorLayoutPrefs(),
  );
  // Hydrate selection/staging from the project on mount so page switches
  // (which remount Editor) restore place instead of an empty preview.
  const [initialSelection] = useState(() => selectionFromProject(project));
  const [selectedAssetId, setSelectedAssetId] = useState(
    initialSelection.selectedAssetId,
  );
  const [selectedAssetIds, setSelectedAssetIds] = useState(
    initialSelection.selectedAssetIds,
  );
  /** Primary selected clip (drives preview staging). */
  const [selectedClipId, setSelectedClipId] = useState(
    initialSelection.selectedClipId,
  );
  /** All selected timeline clips (includes primary). */
  const [selectedClipIds, setSelectedClipIds] = useState(
    initialSelection.selectedClipIds,
  );
  /** Staging fields taken from the clicked timeline clip. */
  const [clipStagingSeed, setClipStagingSeed] = useState(
    initialSelection.clipStagingSeed,
  );
  /** Source-only staging restored across remounts (pre-drop settings). */
  const [pendingStagedDraft, setPendingStagedDraft] = useState(
    initialSelection.pendingStagedDraft,
  );
  const [previewVolume, setPreviewVolume] = useState(80);
  const [assetFilter, setAssetFilter] = useState<AssetKindFilter>("all");
  const [addAssetSlotActive, setAddAssetSlotActive] = useState(false);
  const [openCompositionId, setOpenCompositionId] = useState<string | null>(
    null,
  );
  const [addAssetIntent, setAddAssetIntent] = useState<AddAssetIntent | null>(
    null,
  );
  const [projectFolders, setProjectFolders] = useState<LibraryFolder[]>([]);
  const [boundFolder, setBoundFolder] = useState<LibraryFolder | null>(null);
  const [mergeModal, setMergeModal] = useState<TimelineMergeModalState | null>(
    null,
  );
  const [joinStudioOpen, setJoinStudioOpen] = useState(false);
  const [joinStudioPair, setJoinStudioPair] = useState<
    ReturnType<typeof getJoinableTimelinePair>
  >(null);
  const joinBusyRef = useRef(false);
  const addAssetGenerationSession = useAddAssetGenerationSession(project.id);
  const prevAddAssetGenerationSessionRef = useRef(addAssetGenerationSession);
  const [narrow, setNarrow] = useState(matchesNarrowViewport);
  const [assetsDrawerOpen, setAssetsDrawerOpen] = useState(false);
  const [assistantDrawerOpen, setAssistantDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const splitterCaptureRef = useRef<{
    target: HTMLElement;
    pointerId: number;
  } | null>(null);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  /** Internal clipboard for Cmd/Ctrl+C / Cmd/Ctrl+V of timeline clips. */
  const clipClipboardRef = useRef<TimelineClip[]>([]);
  const mergeRunningRef = useRef(false);
  /** Asset ids last observed on the open project — used to detect removals only. */
  const knownAssetIdsRef = useRef<{
    projectId: string;
    ids: Set<string>;
  } | null>(null);

  const clearClipSelection = () => {
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setClipStagingSeed(null);
    setOpenProjectSelectedTimelineClipId(null);
  };

  const clearPendingStagedDraft = () => {
    setPendingStagedDraft(null);
    setOpenProjectPendingStagedDraft(null);
  };

  const applyPrimaryClip = (clip: TimelineClip) => {
    setAddAssetSlotActive(false);
    setAddAssetIntent(null);
    setSelectedAssetId(null);
    setSelectedAssetIds([]);
    clearPendingStagedDraft();
    setSelectedClipId(clip.id);
    const draft = timelineClipToStagedDraft(clip);
    setClipStagingSeed(draft ? { clipId: clip.id, draft } : null);
    setOpenProjectSelectedTimelineClipId(clip.id);
    setOpenProjectTimelineMonitorActive(false);
    seekTimelinePlayhead(clip.startSec);
  };

  const monitorMode: "source" | "timeline" = project.timelineMonitorActive
    ? "timeline"
    : "source";
  const [liveTimeline, setLiveTimeline] = useState<TimelineClip[] | null>(null);
  const displayTimeline = liveTimeline ?? project.timeline;
  const sequenceDurationSec = timelineSequenceDuration(displayTimeline);
  const editorMainAudioCreationId = useMemo(
    () =>
      resolveEditorMainAudioCreationId(
        displayTimeline,
        project.mainAudioCreationId,
        project.assets.find((asset) => asset.kind === "audio")?.id ?? null,
      ),
    [displayTimeline, project.mainAudioCreationId, project.assets],
  );
  /**
   * While playing, the playback engine owns the playhead RAF; React only
   * receives throttled onTimeUpdate for the ruler. When paused, the persisted
   * project playhead is the source of truth.
   */
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [livePlayheadSec, setLivePlayheadSec] = useState(
    project.timelinePlayheadSec,
  );
  /** Bumped on scrub-while-playing so media re-primes. */
  const [mediaSeekEpoch, setMediaSeekEpoch] = useState(0);
  const livePlayheadRef = useRef(project.timelinePlayheadSec);
  const wasTimelinePlayingRef = useRef(false);
  const toggleTimelinePlayingRef = useRef<() => void>(() => {});
  const displayPlayheadSec = timelinePlaying
    ? livePlayheadSec
    : project.timelinePlayheadSec;
  const mergeSelection = useMemo(
    () => getMergeableTimelineSelection(project.timeline, selectedClipIds),
    [project.timeline, selectedClipIds],
  );
  const joinPair = useMemo(
    () => getJoinableTimelinePair(project.timeline, selectedClipIds),
    [project.timeline, selectedClipIds],
  );

  const projectFolderIdsKey = project.folderIds.join("\0");
  const boundFolderId = project.boundFolderId?.trim() || null;

  useEffect(() => {
    void (async () => {
      try {
        // One-time migration of existing frontend projects, then backend is
        // queried as the project-asset authority.
        if (boundFolderId) {
          await setProjectBoundFolder(
            project.id,
            boundFolderId,
            project.assets.map((asset) => asset.id),
          );
        } else {
          const backendFolderId = await getProjectBoundFolder(project.id);
          if (backendFolderId) {
            setOpenProjectBoundFolderId(backendFolderId);
          }
        }
        const backendIds = await listProjectAssetIds(project.id);
        const backend = new Set(backendIds);
        const frontendIds = project.assets.map((asset) => asset.id);
        const missing = backendIds.filter((id) => !frontendIds.includes(id));
        const stale = frontendIds.filter((id) => !backend.has(id));
        if (missing.length > 0) addCreationsToOpenProject(missing);
        if (stale.length > 0) removeCreationsFromOpenProject(stale);
      } catch (error) {
        console.error("Failed to load backend project assets", error);
      }
    })();
  }, [boundFolderId, project.id]);

  if (project.folderIds.length === 0 && projectFolders.length > 0) {
    setProjectFolders([]);
  }
  if (!boundFolderId && boundFolder) {
    setBoundFolder(null);
  }

  useEffect(() => {
    if (project.folderIds.length === 0) return;
    const wanted = new Set(project.folderIds);
    let cancelled = false;
    void (async () => {
      try {
        const all = await listFolders();
        if (cancelled) return;
        setProjectFolders(
          all.filter(
            (folder) =>
              wanted.has(folder.id) && folder.id !== boundFolderId,
          ),
        );
      } catch (error) {
        console.error("Failed to load project folders", error);
        if (!cancelled) setProjectFolders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectFolderIdsKey, project.assets.length, project.folderIds, boundFolderId]);

  useEffect(() => {
    if (!boundFolderId) {
      setBoundFolder(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const folder = await getFolder(boundFolderId);
        if (cancelled) return;
        let resolvedFolder = folder;
        const members = new Set(folder.memberIds);
        const unfiledProjectIds = project.assets
          .map((asset) => asset.id.trim())
          .filter((id) => id && !members.has(id));
        if (unfiledProjectIds.length > 0) {
          resolvedFolder = await addToFolder(boundFolderId, unfiledProjectIds);
          if (cancelled) return;
        }
        setBoundFolder(resolvedFolder);
      } catch (error) {
        console.error("Failed to load bound working folder", error);
        if (!cancelled) setBoundFolder(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    boundFolderId,
    project.assets.length,
    project.id,
  ]);

  const boundFolderLocked = useMemo(() => {
    if (!boundFolder) return false;
    return isBoundFolderLockedByTimeline(
      project.timeline,
      boundFolder.memberIds,
    );
  }, [boundFolder, project.timeline]);

  const projectAssetIdsKey = useMemo(
    () => project.assets.map((asset) => asset.id).join("\0"),
    [project.assets],
  );

  // Cabinet covers alone are on the project; members must be project assets too
  // so Assets selection / timeline staging aren't cleared as "stale".
  useEffect(() => {
    const cabinetIds = [project.imagesGroupId, project.videosGroupId]
      .map((id) => (id ? String(id).trim() : ""))
      .filter(Boolean);
    if (cabinetIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const covers = await getCreations(cabinetIds);
        if (cancelled) return;
        const known = new Set(
          projectAssetIdsKey ? projectAssetIdsKey.split("\0") : [],
        );
        const missing: string[] = [];
        for (const cover of covers) {
          for (const mid of groupSourceCreationIds(cover)) {
            if (!known.has(mid) && !missing.includes(mid)) missing.push(mid);
          }
        }
        if (missing.length > 0) addCreationsToOpenProject(missing);
      } catch (error) {
        console.error("Failed to hydrate project cabinet members", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    addCreationsToOpenProject,
    project.imagesGroupId,
    project.id,
    project.videosGroupId,
    projectAssetIdsKey,
  ]);

  const pauseTimelinePlayback = () => {
    if (!timelinePlaying) return;
    setTimelinePlaying(false);
    // Persist now so displayPlayheadSec (project playhead when paused) does not
    // jump backward. Engine layout pause may refine via onTimeUpdate afterward.
    setOpenProjectTimelinePlayheadSec(livePlayheadRef.current);
  };

  // Persist playhead after the engine emits its final time on pause.
  useEffect(() => {
    if (wasTimelinePlayingRef.current && !timelinePlaying) {
      setOpenProjectTimelinePlayheadSec(livePlayheadRef.current);
    }
    wasTimelinePlayingRef.current = timelinePlaying;
  }, [timelinePlaying, setOpenProjectTimelinePlayheadSec]);

  /** Engine → React: throttled ruler updates while playing; accurate on pause. */
  const onTimelineEngineTimeUpdate = (sec: number) => {
    livePlayheadRef.current = sec;
    setLivePlayheadSec(sec);
  };

  const seekTimelinePlayhead = (sec: number) => {
    const end = Math.max(sequenceDurationSec, sec, 0.1);
    const next = Math.max(0, Math.min(end, sec));
    livePlayheadRef.current = next;
    setLivePlayheadSec(next);
    setOpenProjectTimelinePlayheadSec(next);
    // Stay in playback — jump media to the new point.
    if (timelinePlaying) setMediaSeekEpoch((n) => n + 1);
  };

  const toggleTimelinePlaying = () => {
    if (timelinePlaying) {
      pauseTimelinePlayback();
      return;
    }
    if (!project.timelineMonitorActive) {
      setOpenProjectTimelineMonitorActive(true);
    }
    const end = sequenceDurationSec;
    if (end <= 0) return;
    const start =
      project.timelinePlayheadSec >= end ? 0 : project.timelinePlayheadSec;
    livePlayheadRef.current = start;
    setLivePlayheadSec(start);
    if (start !== project.timelinePlayheadSec) {
      setOpenProjectTimelinePlayheadSec(start);
    }
    setTimelinePlaying(true);
  };
  // Keep the latest toggle in a ref so the Space handler stays stable.
  // eslint-disable-next-line react-hooks/refs -- intentional latest-handler mirror
  toggleTimelinePlayingRef.current = toggleTimelinePlaying;

  // Space toggles play/pause while the program monitor owns the preview,
  // as long as focus isn't in a field or other interactive control.
  useEffect(() => {
    if (monitorMode !== "timeline") return;

    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isInteractiveKeyboardTarget(event.target)) return;
      event.preventDefault();
      toggleTimelinePlayingRef.current();
    };

    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [monitorMode]);

  // Delete / Backspace removes selected timeline clips after confirm.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (selectedClipIds.length === 0) return;
      if (
        addAssetGenerationSession?.phase === "running" &&
        selectedClipIds.includes(addAssetGenerationSession.clipId)
      ) {
        return;
      }
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      const ids = new Set(selectedClipIds);
      const count = ids.size;
      void (async () => {
        const ok = await confirm({
          title: count === 1 ? "Remove clip?" : `Remove ${count} clips?`,
          message:
            count === 1
              ? "Removes this clip from the timeline."
              : `Removes ${count} clips from the timeline.`,
          confirmLabel: "Remove",
          danger: true,
        });
        if (!ok) return;
        pauseTimelinePlayback();
        setOpenProjectTimeline(
          project.timeline.filter((clip) => !ids.has(clip.id)),
        );
        clearClipSelection();
      })();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers are intentionally fresh each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedClipIds,
    addAssetGenerationSession,
    project.timeline,
    confirm,
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
    timelinePlaying,
  ]);

  // Cmd/Ctrl+C copies selected clips; Cmd/Ctrl+V pastes after the last clip
  // on each target lane (no overlap), preserving relative offsets.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      if (isEditableKeyboardTarget(event.target)) return;

      if (key === "c") {
        if (selectedClipIds.length === 0) return;
        const idSet = new Set(selectedClipIds);
        const clips = project.timeline
          .filter((c) => idSet.has(c.id))
          .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id))
          .map((c) => ({ ...c }));
        if (clips.length === 0) return;
        event.preventDefault();
        clipClipboardRef.current = clips;
        return;
      }

      const sources = clipClipboardRef.current;
      if (sources.length === 0) return;
      event.preventDefault();
      const origin = Math.min(...sources.map((c) => c.startSec));
      const startBase = pasteAppendStartSec(project.timeline, sources);
      const pasted = sources.map((source) => {
        const duration = Math.max(0.1, source.endSec - source.startSec);
        const startSec = startBase + (source.startSec - origin);
        return {
          ...source,
          id: newTimelineClipId(),
          startSec,
          endSec: startSec + duration,
        };
      });
      setOpenProjectTimeline([...project.timeline, ...pasted]);
      pauseTimelinePlayback();
      const primary = pasted[0];
      if (primary) {
        setSelectedAssetId(null);
        setSelectedAssetIds([]);
        setSelectedClipId(primary.id);
        setSelectedClipIds(pasted.map((c) => c.id));
        const draft = timelineClipToStagedDraft(primary);
        setClipStagingSeed(draft ? { clipId: primary.id, draft } : null);
        setOpenProjectSelectedTimelineClipId(primary.id);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers are intentionally fresh each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedClipIds,
    project.timeline,
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
  ]);

  const [hydratedProjectId, setHydratedProjectId] = useState(project.id);
  if (project.id !== hydratedProjectId) {
    setHydratedProjectId(project.id);
    const next = selectionFromProject(project);
    setSelectedAssetId(next.selectedAssetId);
    setSelectedAssetIds(next.selectedAssetIds);
    setSelectedClipId(next.selectedClipId);
    setSelectedClipIds(next.selectedClipIds);
    setClipStagingSeed(next.clipStagingSeed);
    setPendingStagedDraft(next.pendingStagedDraft);
  }

  // Drop local selection if clips were removed from the timeline.
  if (selectedClipIds.length > 0) {
    const alive = new Set(project.timeline.map((c) => c.id));
    const nextIds = selectedClipIds.filter((id) => alive.has(id));
    const clipSelectionStale =
      nextIds.length !== selectedClipIds.length ||
      (selectedClipId !== null && !alive.has(selectedClipId));
    if (clipSelectionStale) {
      if (nextIds.length === 0) {
        setSelectedClipId(null);
        setSelectedClipIds([]);
        setClipStagingSeed(null);
      } else {
        setSelectedClipIds(nextIds);
        const primaryId =
          selectedClipId && nextIds.includes(selectedClipId)
            ? selectedClipId
            : nextIds[0];
        const primary = project.timeline.find((c) => c.id === primaryId);
        setSelectedClipId(primaryId);
        if (primary) {
          const draft = timelineClipToStagedDraft(primary);
          setClipStagingSeed(draft ? { clipId: primary.id, draft } : null);
        } else {
          setClipStagingSeed(null);
        }
      }
    }
  }

  // Drop local asset selections only when assets leave the project.
  // Expanded cabinet members can be selected (and briefly held) before they
  // are promoted onto project.assets — those must not look "stale".
  // Intentional prev-vs-current diff via a ref during render (see removed-set logic).
  /* eslint-disable react-hooks/refs */
  if (
    knownAssetIdsRef.current === null ||
    knownAssetIdsRef.current.projectId !== project.id
  ) {
    knownAssetIdsRef.current = {
      projectId: project.id,
      ids: new Set(project.assets.map((asset) => asset.id)),
    };
  }
  {
    const alive = new Set(project.assets.map((asset) => asset.id));
    const known = knownAssetIdsRef.current.ids;
    const removed: string[] = [];
    for (const id of known) {
      if (!alive.has(id)) removed.push(id);
    }
    knownAssetIdsRef.current = { projectId: project.id, ids: alive };
    /* eslint-enable react-hooks/refs */

    if (
      removed.length > 0 &&
      (selectedAssetIds.length > 0 || selectedAssetId)
    ) {
      const removeSet = new Set(removed);
      const next = selectedAssetIds.filter((id) => !removeSet.has(id));
      const primaryStill =
        selectedAssetId !== null && !removeSet.has(selectedAssetId)
          ? selectedAssetId
          : null;
      const assetSelectionStale =
        next.length !== selectedAssetIds.length ||
        (selectedAssetId !== null && primaryStill === null);
      if (assetSelectionStale) {
        const primary =
          primaryStill && next.includes(primaryStill)
            ? primaryStill
            : (next[next.length - 1] ?? null);
        setSelectedAssetIds(next);
        setSelectedAssetId(primary);
        setOpenProjectSelectedAssetId(primary);
      }
    }
  }

  useEffect(() => {
    let offProgress: (() => void) | undefined;
    void listen<MergeProgress>("library-merge-progress", (event) => {
      setMergeModal((prev) => {
        if (!prev || prev.phase !== "running") return prev;
        return { ...prev, progress: event.payload };
      });
    }).then((off) => {
      offProgress = off;
    });
    return () => {
      offProgress?.();
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (!narrow && (assetsDrawerOpen || assistantDrawerOpen)) {
    setAssetsDrawerOpen(false);
    setAssistantDrawerOpen(false);
  }

  useEffect(() => installEditorGestureSafetyNet(), []);

  useEffect(
    () =>
      registerGestureStatusProvider("editorLayout", () => ({
        splitterDrag: dragRef.current?.kind ?? null,
        workspaceResizing: dragging,
      })),
    [dragging],
  );

  useEffect(() => {
    const releaseSplitterCapture = () => {
      const capture = splitterCaptureRef.current;
      if (!capture) return;
      releasePointerCaptureSafe(capture.target, capture.pointerId);
      splitterCaptureRef.current = null;
    };

    const endSplitterDrag = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(null);
      releaseSplitterCapture();
      saveEditorLayoutPrefs(prefsRef.current);
    };

    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const workspace = workspaceRef.current;
      const workspaceW = workspace?.clientWidth ?? 0;
      const workspaceH = workspace?.clientHeight ?? 0;

      if (drag.kind === "assets") {
        const next = clampAssetsWidth(
          drag.startAssets + (event.clientX - drag.startX),
          {
            workspaceWidth: workspaceW,
            reservedRight: drag.reservedRight,
          },
        );
        setPrefs((p) => ({ ...p, assetsWidth: next }));
      } else if (drag.kind === "assistant") {
        const next = clampAssistantWidth(
          drag.startAssistant - (event.clientX - drag.startX),
          {
            workspaceWidth: workspaceW,
            reservedLeft: drag.reservedLeft,
          },
        );
        setPrefs((p) => ({ ...p, assistantWidth: next }));
      } else {
        const next = clampTimelineHeight(
          drag.startTimeline - (event.clientY - drag.startY),
          workspaceH,
        );
        setPrefs((p) => ({ ...p, timelineHeight: next }));
      }
    };

    const onUp = () => {
      endSplitterDrag();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    const unsubscribeAbort = subscribeGestureAbort(endSplitterDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      unsubscribeAbort();
      endSplitterDrag();
    };
  }, []);

  const beginDrag = (
    kind: DragKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
      splitterCaptureRef.current = { target, pointerId: event.pointerId };
    } catch {
      splitterCaptureRef.current = null;
    }
    const reservedRight = !rightCollapsed
      ? prefs.assistantWidth
      : ASSISTANT_COLLAPSED_STRIP;
    const reservedLeft = !leftCollapsed ? prefs.assetsWidth : 0;
    dragRef.current = {
      kind,
      startX: event.clientX,
      startY: event.clientY,
      startAssets: prefs.assetsWidth,
      startAssistant: prefs.assistantWidth,
      startTimeline: prefs.timelineHeight,
      reservedRight,
      reservedLeft,
    };
    setDragging(kind);
  };

  const assetsDocked = !narrow && !leftCollapsed;
  const assistantDocked = !narrow && !rightCollapsed;
  const showAssetsDrawer = narrow && assetsDrawerOpen;
  const showAssistantDrawer = narrow && assistantDrawerOpen;
  const showAssetsPane = assetsDocked || showAssetsDrawer;
  const showAssistantPane = assistantDocked || showAssistantDrawer;

  const workspaceClass = [
    "editor-workspace",
    assetsDocked ? "" : "assets-collapsed",
    assistantDocked ? "" : "assistant-collapsed",
    narrow ? "is-narrow" : "",
    dragging ? `is-resizing-${dragging}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const style = {
    "--editor-assets-w": `${prefs.assetsWidth}px`,
    "--editor-assistant-w": `${prefs.assistantWidth}px`,
    "--editor-timeline-h": `${prefs.timelineHeight}px`,
  } as CSSProperties;

  const collapseAssets = () => {
    if (narrow) setAssetsDrawerOpen(false);
    else toggleLeft();
  };

  const expandAssets = () => {
    if (narrow) setAssetsDrawerOpen(true);
    else toggleLeft();
  };

  const collapseAssistant = () => {
    if (narrow) setAssistantDrawerOpen(false);
    else toggleRight();
  };

  const expandAssistant = () => {
    if (narrow) setAssistantDrawerOpen(true);
    else toggleRight();
  };

  const selectAssets = (ids: string[], primaryId: string | null) => {
    pauseTimelinePlayback();
    // A normal asset selection leaves the composition sandbox. Keeping the
    // parent id set causes PreviewPane's open-composition effect to reopen it
    // immediately after its local selection reset.
    setOpenCompositionId(null);
    setAddAssetSlotActive(false);
    setAddAssetIntent(null);
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setClipStagingSeed(null);
    // Promote cabinet members onto the project in the same write as selection
    // so persisted selectedAssetId isn't normalized away.
    selectCreationsOnOpenProject(ids, primaryId);
    setSelectedAssetIds(ids);
    setSelectedAssetId(primaryId);
    if (!pendingDraftMatchesSelection(pendingStagedDraft, ids)) {
      clearPendingStagedDraft();
    }
  };

  const selectAddAssetSlot = () => {
    pauseTimelinePlayback();
    setOpenCompositionId(null);
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setClipStagingSeed(null);
    setSelectedAssetIds([]);
    setSelectedAssetId(null);
    setOpenProjectSelectedAssetId(null);
    setOpenProjectSelectedTimelineClipId(null);
    setOpenProjectTimelineMonitorActive(false);
    clearPendingStagedDraft();
    setAddAssetIntent(null);
    setAddAssetSlotActive(true);
  };

  const onSourceDraftChange = (draft: StagedClipDraft) => {
    setPendingStagedDraft(draft);
    setOpenProjectPendingStagedDraft(draft);
  };

  const selectClip = (
    clip: TimelineClip | null,
    opts?: { additive?: boolean },
  ) => {
    pauseTimelinePlayback();
    if (!clip) {
      clearClipSelection();
      return;
    }

    if (opts?.additive) {
      const has = selectedClipIds.includes(clip.id);
      if (has) {
        const next = selectedClipIds.filter((id) => id !== clip.id);
        if (next.length === 0) {
          clearClipSelection();
          return;
        }
        setSelectedClipIds(next);
        if (selectedClipId === clip.id) {
          const primary =
            project.timeline.find((c) => c.id === next[next.length - 1]) ?? null;
          if (primary) applyPrimaryClip(primary);
        }
        return;
      }
      setSelectedClipIds([...selectedClipIds, clip.id]);
      applyPrimaryClip(clip);
      return;
    }

    applyPrimaryClip(clip);
    setSelectedClipIds([clip.id]);
  };

  const activateTimeline = () => {
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setClipStagingSeed(null);
    setSelectedAssetId(null);
    setSelectedAssetIds([]);
    setAddAssetSlotActive(false);
    setAddAssetIntent(null);
    clearPendingStagedDraft();
    setOpenProjectTimelineMonitorActive(true);
  };

  const [bakeInfoByClipId, setBakeInfoByClipId] = useState<
    Map<string, BakeInfo>
  >(() => new Map());
  const bakeInflightRef = useRef<Set<string>>(new Set());
  const timelineRef = useRef(project.timeline);
  const aspectRatioRef = useRef(project.aspectRatio);
  const selectedClipIdsRef = useRef(selectedClipIds);

  useEffect(() => {
    timelineRef.current = displayTimeline;
    aspectRatioRef.current = project.aspectRatio;
  }, [displayTimeline, project.aspectRatio]);

  useEffect(() => {
    // Drop live (in-gesture) timeline when the selection changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiveTimeline(null);
  }, [selectedClipId]);

  useEffect(() => {
    selectedClipIdsRef.current = selectedClipIds;
  }, [selectedClipIds]);

  const ensureSlideshowBake = (clip: TimelineClip) => {
    if (clip.kind !== "slideshow" || !clip.slideshow) return;
    if (bakeInflightRef.current.has(clip.id)) return;
    const timelineDurationSec = Math.max(0.1, clip.endSec - clip.startSec);
    const sourceInSec = Number.isFinite(clip.inSec)
      ? Math.max(0, Number(clip.inSec))
      : 0;
    const durationSec = Number.isFinite(clip.outSec)
      ? Math.max(timelineDurationSec, Number(clip.outSec))
      : sourceInSec + timelineDurationSec;
    if (
      isBeatSlideshowMode(clip.slideshow.mode) &&
      !clip.slideshow.audioAssetId?.trim()
    ) {
      setBakeInfoByClipId((prev) => {
        const next = new Map(prev);
        next.set(clip.id, {
          status: "failed",
          error:
            "Beat sync needs overlapping Master Audio under this clip. Drop the slideshow over an audio clip, or switch Mode to Slideshow.",
        });
        return next;
      });
      return;
    }
    bakeInflightRef.current.add(clip.id);
    setBakeInfoByClipId((prev) => {
      const next = new Map(prev);
      next.set(clip.id, { status: "generating", error: null });
      return next;
    });
    const input = slideshowEnsureInputFromRecipe({
      recipe: clip.slideshow,
      durationSec,
      framing: clip.framing,
      aspectRatio: aspectRatioRef.current,
      clipStartSec: clip.startSec - sourceInSec,
    });
    void ensureSlideshowMedia(input)
      .then((result) => {
        bakeInflightRef.current.delete(clip.id);
        setBakeInfoByClipId((prev) => {
          const next = new Map(prev);
          next.set(clip.id, { status: "ready", error: null });
          return next;
        });
        // Attach bake onto the latest store timeline (not a possibly-stale ref
        // snapshot) and keep the recipe that was actually encoded.
        setOpenProjectTimeline((prev) =>
          prev.map((row) =>
            row.id === clip.id
              ? {
                  ...row,
                  slideshow: clip.slideshow,
                  bakeKey: result.bakeKey,
                  bakePath: result.path,
                }
              : row,
          ),
        );
        setClipStagingSeed((prev) => {
          if (!prev || prev.clipId !== clip.id) return prev;
          return {
            ...prev,
            draft: {
              ...prev.draft,
              slideshow: clip.slideshow,
              bakeKey: result.bakeKey,
              bakePath: result.path,
            },
          };
        });
      })
      .catch((error: unknown) => {
        bakeInflightRef.current.delete(clip.id);
        const message = formatBakeError(error);
        console.error("Slideshow bake failed", message);
        setBakeInfoByClipId((prev) => {
          const next = new Map(prev);
          next.set(clip.id, { status: "failed", error: message });
          return next;
        });
      });
  };

  const ensureClipExtendBake = (clip: TimelineClip) => {
    if (!clipNeedsExtendBake(clip)) return;
    if (bakeInflightRef.current.has(clip.id)) return;
    const assetId = clip.assetId?.trim();
    const bakeKey = computeExtendBakeKey(clip);
    const targetSec = computeExtendBakeTargetSec(clip);
    if (!assetId || !bakeKey || targetSec == null) return;

    const previousBakePath = clip.extendBakePath?.trim() || null;

    bakeInflightRef.current.add(clip.id);
    setBakeInfoByClipId((prev) => {
      const next = new Map(prev);
      next.set(clip.id, { status: "generating", error: null });
      return next;
    });

    void getCreation(assetId)
      .then(async (creation) => {
        const sourcePath = creation.localPath?.trim();
        if (!sourcePath) {
          throw new Error("Video has no local path — sync it to the library first");
        }
        const inSec = clipInSec(clip);
        const outSec = clipOutSec(clip);
        const baked = await bakeClipExtend({
          sourcePath,
          pingPong: clip.extendPingPong === true,
          targetSec,
          inSec,
          outSec,
          // Extend bakes are always 1× material; speed is applied at playback.
        });
        return { bakeKey, path: baked.path, coverSec: targetSec };
      })
      .then((result) => {
        bakeInflightRef.current.delete(clip.id);
        if (previousBakePath && previousBakePath !== result.path.trim()) {
          void deleteExtendCacheFile(previousBakePath).catch((error: unknown) => {
            console.warn("Could not delete previous extend bake", error);
          });
        }
        setBakeInfoByClipId((prev) => {
          const next = new Map(prev);
          next.set(clip.id, { status: "ready", error: null });
          return next;
        });
        setOpenProjectTimeline(
          timelineRef.current.map((row) =>
            row.id === clip.id
              ? {
                  ...row,
                  extendBakeKey: result.bakeKey,
                  extendBakePath: result.path,
                  extendBakeCoverSec: result.coverSec,
                }
              : row,
          ),
        );
        setClipStagingSeed((prev) => {
          if (!prev || prev.clipId !== clip.id) return prev;
          return {
            ...prev,
            draft: {
              ...prev.draft,
              extendBakeKey: result.bakeKey,
              extendBakePath: result.path,
            },
          };
        });
      })
      .catch((error: unknown) => {
        bakeInflightRef.current.delete(clip.id);
        const message = formatBakeError(error);
        console.error("Extend bake failed", message);
        setBakeInfoByClipId((prev) => {
          const next = new Map(prev);
          next.set(clip.id, { status: "failed", error: message });
          return next;
        });
      });
  };

  const slideshowBakeTimelineKey = project.timeline
    .map((c) => {
      const s = c.slideshow;
      return [
        c.id,
        c.kind,
        c.bakePath ?? "",
        c.startSec,
        c.endSec,
        c.inSec ?? "",
        c.outSec ?? "",
        c.framing ?? "",
        s?.mode ?? "",
        s?.random ? 1 : 0,
        s?.seed ?? "",
        s?.sensitivity ?? "",
        (s?.imageAssetIds ?? []).join(","),
        s?.audioAssetId ?? "",
        s?.audioInSec ?? "",
        s?.audioOutSec ?? "",
        s?.audioStartSec ?? "",
        s?.audioEndSec ?? "",
      ].join(":");
    })
    .join("|");
  const audioClipTimelineKey = project.timeline
    .filter((c) => c.lane === "audio" || c.kind === "audio")
    .map(
      (c) =>
        `${c.id}:${c.assetId ?? ""}:${c.startSec}:${c.endSec}:${c.inSec ?? ""}:${c.outSec ?? ""}`,
    )
    .join("|");

  // Rebind beat-sync audio from current overlap (does not bake).
  useEffect(() => {
    let changed = false;
    const rebound = project.timeline.map((clip) => {
      if (
        clip.kind !== "slideshow" ||
        clip.bakePath?.trim() ||
        bakeInflightRef.current.has(clip.id) ||
        !isBeatSlideshowMode(clip.slideshow?.mode)
      ) {
        return clip;
      }
      const audio = findOverlappingAudioClip(project.timeline, {
        startSec: clip.startSec,
        endSec: clip.endSec,
      });
      const nextRecipe = {
        ...clip.slideshow,
        audioAssetId: audio?.assetId,
        audioInSec: audio?.inSec ?? 0,
        audioOutSec: audio?.outSec,
        audioStartSec: audio?.startSec,
        audioEndSec: audio?.endSec,
      };
      if (slideshowRecipesEqual(clip.slideshow, nextRecipe)) return clip;
      changed = true;
      return {
        ...clip,
        slideshow: nextRecipe,
        bakeKey: null,
        bakePath: null,
      };
    });
    if (changed) {
      // Never cancel an in-flight bake here — that flipped the toolbar back to
      // "Render" while ffmpeg was still running, then the completion write lost
      // its bakePath to recipe-invalidate.
      setBakeInfoByClipId((prev) => {
        const next = new Map(prev);
        for (let i = 0; i < rebound.length; i += 1) {
          const before = project.timeline[i];
          const after = rebound[i];
          if (
            before &&
            after &&
            before.id === after.id &&
            !bakeInflightRef.current.has(after.id) &&
            !slideshowRecipesEqual(before.slideshow, after.slideshow)
          ) {
            next.delete(after.id);
          }
        }
        return next;
      });
      setOpenProjectTimeline(rebound);
      setClipStagingSeed((prev) => {
        if (!prev) return prev;
        if (bakeInflightRef.current.has(prev.clipId)) return prev;
        const updated = rebound.find((c) => c.id === prev.clipId);
        if (!updated) return prev;
        const draft = timelineClipToStagedDraft(updated);
        return draft ? { clipId: updated.id, draft } : prev;
      });
      return;
    }

    for (const clip of project.timeline) {
      if (clip.kind === "slideshow" && clip.slideshow && clip.bakePath?.trim()) {
        setBakeInfoByClipId((prev) => {
          if (prev.get(clip.id)?.status === "ready") return prev;
          const next = new Map(prev);
          next.set(clip.id, { status: "ready", error: null });
          return next;
        });
        continue;
      }
      if (clipHasFreshExtendBake(clip)) {
        setBakeInfoByClipId((prev) => {
          if (prev.get(clip.id)?.status === "ready") return prev;
          const next = new Map(prev);
          next.set(clip.id, { status: "ready", error: null });
          return next;
        });
      }
    }
  }, [
    project.id,
    project.aspectRatio,
    project.timeline,
    setOpenProjectTimeline,
    slideshowBakeTimelineKey,
    audioClipTimelineKey,
  ]);

  const onClipDraftChange = (
    clipId: string,
    draft: StagedClipDraft,
    options?: { live?: boolean },
  ) => {
    if (
      addAssetGenerationSession?.phase === "running" &&
      addAssetGenerationSession.clipId === clipId
    ) {
      return;
    }
    const next = timelineRef.current.map((clip) =>
      clip.id === clipId ? applyDraftToTimelineClip(clip, draft) : clip,
    );
    const updated = next.find((clip) => clip.id === clipId);
    if (options?.live) {
      timelineRef.current = next;
      setLiveTimeline(next);
      return;
    }
    timelineRef.current = next;
    setLiveTimeline(null);
    const syncedDraft =
      updated && (updated.kind === "image" || updated.kind === "video")
        ? (timelineClipToStagedDraft(updated) ?? draft)
        : draft;
    setClipStagingSeed({ clipId, draft: syncedDraft });
    setOpenProjectTimeline(next);
    if (updated?.kind === "slideshow" && !updated.bakePath) {
      bakeInflightRef.current.delete(clipId);
      setBakeInfoByClipId((prev) => {
        const map = new Map(prev);
        map.delete(clipId);
        return map;
      });
    }
    if (updated?.kind === "video" && clipNeedsExtendBake(updated)) {
      bakeInflightRef.current.delete(clipId);
      setBakeInfoByClipId((prev) => {
        const map = new Map(prev);
        map.delete(clipId);
        return map;
      });
    }
  };

  const syncClipStagingFromTimeline = useCallback((timeline: TimelineClip[]) => {
    setClipStagingSeed((prev) => {
      if (!prev) return prev;
      const clip = timeline.find((row) => row.id === prev.clipId);
      if (!clip || (clip.kind !== "image" && clip.kind !== "video")) {
        return prev;
      }
      const draft = timelineClipToStagedDraft(clip);
      if (!draft) return prev;
      if (clip.kind === "image") {
        if (
          prev.draft.inSec === draft.inSec &&
          prev.draft.outSec === draft.outSec
        ) {
          return prev;
        }
      } else if (
        prev.draft.inSec === draft.inSec &&
        prev.draft.outSec === draft.outSec &&
        prev.draft.timelineDurationSec === draft.timelineDurationSec &&
        prev.draft.speed === draft.speed &&
        prev.draft.extendPingPong === draft.extendPingPong &&
        prev.draft.extendBakeKey === draft.extendBakeKey &&
        prev.draft.extendBakePath === draft.extendBakePath
      ) {
        return prev;
      }
      return { clipId: prev.clipId, draft };
    });
  }, []);

  const onTimelineClipsChange = useCallback(
    (next: TimelineClip[], options?: { live?: boolean }) => {
      // Keep ref in sync during the same event turn so child effects (e.g.
      // AddAssetGeneratePanel mount persist) do not rewrite a stale timeline
      // and wipe a just-placed placeholder.
      const prev = timelineRef.current;
      const prevIds = new Set(prev.map((c) => c.id));
      const added = next
        .filter((c) => !prevIds.has(c.id))
        .map((c) => c.id);
      const removed = prev
        .filter((c) => !next.some((n) => n.id === c.id))
        .map((c) => c.id);
      timelineRef.current = next;
      if (!options?.live) {
        recordUiOpTrace({
          type: "timeline_commit",
          count: next.length,
          clipId: added[0],
          reason: `${prev.length}->${next.length} added=${added.slice(0, 3).join(",") || "none"} removed=${removed.slice(0, 3).join(",") || "none"}`,
        });
      }
      if (options?.live) {
        setLiveTimeline(next);
        syncClipStagingFromTimeline(next);
        return;
      }
      setLiveTimeline(null);
      setOpenProjectTimeline(next);
      syncClipStagingFromTimeline(next);
    },
    [setLiveTimeline, setOpenProjectTimeline, syncClipStagingFromTimeline],
  );

  const onSlideshowRender = () => {
    const clipId = clipStagingSeed?.clipId;
    if (!clipId) return;
    const clip = timelineRef.current.find((row) => row.id === clipId);
    if (!clip || clip.kind !== "slideshow" || !clip.slideshow) return;

    let target = clip;
    if (clip.slideshow.random) {
      const seed = newSlideshowSeed();
      const slideshow = { ...clip.slideshow, random: true as const, seed };
      target = { ...clip, slideshow, bakeKey: null, bakePath: null };
      setOpenProjectTimeline(
        timelineRef.current.map((row) => (row.id === clipId ? target : row)),
      );
      setClipStagingSeed((prev) => {
        if (!prev || prev.clipId !== clipId) return prev;
        return {
          ...prev,
          draft: {
            ...prev.draft,
            slideshow,
            bakeKey: null,
            bakePath: null,
          },
        };
      });
    }
    ensureSlideshowBake(target);
  };

  const onExtendBake = () => {
    const clipId = clipStagingSeed?.clipId;
    if (!clipId) return;
    const clip = timelineRef.current.find((row) => row.id === clipId);
    if (!clip || !clipNeedsExtendBake(clip)) return;
    ensureClipExtendBake(clip);
  };

  const selectedBakeInfo =
    selectedClipId != null ? bakeInfoByClipId.get(selectedClipId) : undefined;

  const openMergeModal = () => {
    if (!mergeSelection || mergeRunningRef.current) return;
    setMergeModal({
      phase: "confirm",
      clipCount: mergeSelection.clips.length,
    });
  };

  const openJoinStudio = () => {
    if (!joinPair || joinBusyRef.current) return;
    pauseTimelinePlayback();
    setJoinStudioPair(joinPair);
    setJoinStudioOpen(true);
  };

  const closeJoinStudio = () => {
    if (joinBusyRef.current) return;
    setJoinStudioOpen(false);
    setJoinStudioPair(null);
  };

  const applyJoinCommit = async (creationId: string, params: JoinStudioParams) => {
    const pair = joinStudioPair;
    if (!pair) return;
    joinBusyRef.current = true;
    try {
      await landCreationsInBoundFolder({
        creationIds: [creationId],
        boundFolderId: project.boundFolderId,
      });
      addCreationsToOpenProject([creationId]);
      const span = joinReplacementSpan(pair, params);
      const joinedClip: TimelineClip = {
        id: newTimelineClipId(),
        label: formatClipDuration(span.durationSec),
        startSec: span.startSec,
        endSec: span.endSec,
        assetId: creationId,
        thumbUrl: null,
        lane: "video",
        kind: "video",
        inSec: 0,
        outSec: span.durationSec,
        includeAudio: false,
        reverse: false,
        transform: "hold",
        framing: "fit",
      };
      const removeIds = new Set([pair.clipA.id, pair.clipB.id]);
      let inserted = false;
      const nextTimeline = project.timeline.flatMap((clip) => {
        if (!removeIds.has(clip.id)) return [clip];
        if (inserted) return [];
        inserted = true;
        return [joinedClip];
      });
      setOpenProjectTimeline(nextTimeline);
      setSelectedAssetId(null);
      setSelectedAssetIds([]);
      setSelectedClipId(joinedClip.id);
      setSelectedClipIds([joinedClip.id]);
      const draft = timelineClipToStagedDraft(joinedClip);
      setClipStagingSeed(draft ? { clipId: joinedClip.id, draft } : null);
      setOpenProjectSelectedTimelineClipId(joinedClip.id);
      setJoinStudioOpen(false);
      setJoinStudioPair(null);
    } finally {
      joinBusyRef.current = false;
    }
  };

  const closeMergeModal = () => {
    if (mergeRunningRef.current) return;
    setMergeModal(null);
  };

  const runMergeSelectedClips = async () => {
    if (!mergeSelection || mergeRunningRef.current) return;

    pauseTimelinePlayback();
    mergeRunningRef.current = true;
    setMergeModal({
      phase: "running",
      clipCount: mergeSelection.clips.length,
      progress: {
        phase: "prepare",
        done: 0,
        total: mergeSelection.clips.length,
      },
    });

    const sourceSelection = mergeSelection;
    try {
      const creation = await mergeTimelineClips(
        sourceSelection.clips.map((clip) => ({
          assetId: clip.assetId ?? "",
          inSec: clip.inSec ?? 0,
          outSec:
            clip.outSec ??
            (clip.inSec ?? 0) + Math.max(0.1, clip.endSec - clip.startSec),
          reverse: Boolean(clip.reverse),
        })),
      );
      await landCreationsInBoundFolder({
        creationIds: [creation.id],
        boundFolderId: project.boundFolderId,
      });
      addCreationsToOpenProject([creation.id]);

      const duration = Math.max(
        0.1,
        sourceSelection.endSec - sourceSelection.startSec,
      );
      const mergedClip: TimelineClip = {
        id: newTimelineClipId(),
        label: formatClipDuration(duration),
        startSec: sourceSelection.startSec,
        endSec: sourceSelection.endSec,
        assetId: creation.id,
        thumbUrl: null,
        lane: "video",
        kind: "video",
        inSec: 0,
        outSec: duration,
        includeAudio: false,
        reverse: false,
        transform: "hold",
        framing: "fit",
      };

      const selectedIds = new Set(sourceSelection.clips.map((clip) => clip.id));
      let inserted = false;
      const nextTimeline = project.timeline.flatMap((clip) => {
        if (!selectedIds.has(clip.id)) return [clip];
        if (inserted) return [];
        inserted = true;
        return [mergedClip];
      });
      setOpenProjectTimeline(nextTimeline);
      setSelectedAssetId(null);
      setSelectedAssetIds([]);
      setSelectedClipId(mergedClip.id);
      setSelectedClipIds([mergedClip.id]);
      const draft = timelineClipToStagedDraft(mergedClip);
      setClipStagingSeed(draft ? { clipId: mergedClip.id, draft } : null);
      setOpenProjectSelectedTimelineClipId(mergedClip.id);
      mergeRunningRef.current = false;
      setMergeModal(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mergeRunningRef.current = false;
      setMergeModal({
        phase: "error",
        clipCount: sourceSelection.clips.length,
        message,
      });
    }
  };

  const assetsUsedOnTimeline = (assetIds: readonly string[]) => {
    const selected = new Set(assetIds);
    const used = new Set<string>();
    for (const clip of project.timeline) {
      if (clip.assetId && selected.has(clip.assetId)) {
        used.add(clip.assetId);
      }
      for (const id of clip.slideshow?.imageAssetIds ?? []) {
        if (selected.has(id)) used.add(id);
      }
      const audioId = clip.slideshow?.audioAssetId;
      if (audioId && selected.has(audioId)) used.add(audioId);
    }
    return used;
  };

  const timelineUsedAssetIds = useMemo(() => {
    const used = new Set<string>();
    for (const clip of project.timeline) {
      if (clip.assetId) used.add(clip.assetId);
      for (const id of clip.slideshow?.imageAssetIds ?? []) {
        used.add(id);
      }
      if (clip.slideshow?.audioAssetId) {
        used.add(clip.slideshow.audioAssetId);
      }
    }
    return used;
  }, [project.timeline]);

  const removeAssetsFromProject = async (assetIds: string[]) => {
    const usedIds = assetsUsedOnTimeline(assetIds);
    if (usedIds.size > 0) {
      await confirm({
        title: usedIds.size === 1 ? "Asset in use" : "Assets in use",
        message:
          usedIds.size === 1
            ? "One selected asset is used on the timeline. Remove its clips first, then try again."
            : `${usedIds.size} selected assets are used on the timeline. Remove their clips first, then try again.`,
        confirmLabel: "OK",
        hideCancel: true,
      });
      return;
    }
    const count = assetIds.length;
    const ok = await confirm({
      title: count === 1 ? "Remove from project?" : `Remove ${count} assets?`,
      message:
        count === 1
          ? "Do you want to remove this asset from the project?"
          : `Do you want to remove these ${count} assets from the project?`,
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    if (boundFolderId) {
      await removeProjectAssets(project.id, assetIds);
    }
    removeCreationsFromOpenProject(assetIds);
    if (selectedAssetId && assetIds.includes(selectedAssetId)) {
      setSelectedAssetId(null);
      setSelectedAssetIds([]);
      setOpenProjectSelectedAssetId(null);
    }
  };

  const removeFoldersFromProject = async (folderIds: string[]) => {
    const chosen = projectFolders.filter((folder) =>
      folderIds.includes(folder.id),
    );
    const memberIds = [
      ...new Set(chosen.flatMap((folder) => folder.memberIds)),
    ].filter((id) => project.assets.some((asset) => asset.id === id));
    const usedIds = assetsUsedOnTimeline(memberIds);
    if (usedIds.size > 0) {
      await confirm({
        title: usedIds.size === 1 ? "Asset in use" : "Assets in use",
        message:
          usedIds.size === 1
            ? "An asset in this folder is used on the timeline. Remove its clips first, then try again."
            : `${usedIds.size} assets in this folder are used on the timeline. Remove their clips first, then try again.`,
        confirmLabel: "OK",
        hideCancel: true,
      });
      return;
    }
    const folderCount = folderIds.length;
    const memberCount = memberIds.length;
    const ok = await confirm({
      title:
        folderCount === 1
          ? "Remove folder from project?"
          : `Remove ${folderCount} folders?`,
      message:
        memberCount === 0
          ? folderCount === 1
            ? "Do you want to remove this folder from the project?"
            : `Do you want to remove these ${folderCount} folders from the project?`
          : folderCount === 1
            ? `Do you want to remove this folder and its ${memberCount} asset${memberCount === 1 ? "" : "s"} from the project?`
            : `Do you want to remove these ${folderCount} folders and their ${memberCount} assets from the project?`,
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    removeFoldersFromOpenProject(folderIds, memberIds);
    if (selectedAssetId && memberIds.includes(selectedAssetId)) {
      setSelectedAssetId(null);
      setSelectedAssetIds([]);
      setOpenProjectSelectedAssetId(null);
    }
  };

  const deleteCompositionsFromProject = async (compositionIds: string[]) => {
    const ids = compositionIds.map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) return;
    const streams = ids
      .map((id) => project.stillWorkstreams.find((row) => row.id === id))
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
    if (streams.length === 0) return;
    const count = streams.length;
    const ok = await confirm({
      title: count === 1 ? "Delete composition?" : `Delete ${count} compositions?`,
      message:
        count === 1
          ? "Removes this composition sandbox. Source images stay in Assets. Unpromoted plate/edit steps inside it are deleted."
          : `Removes these ${count} composition sandboxes. Source images stay in Assets. Unpromoted plate/edit steps inside them are deleted.`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    const internalCreationIds = new Set<string>();
    const internalCachePaths = new Set<string>();
    for (const stream of streams) {
      for (const node of stream.nodes) {
        if (node.status === "discarded") continue;
        if (node.showOutside) continue;
        const creationId = node.creationId?.trim();
        if (creationId) internalCreationIds.add(creationId);
        const localPath = node.localPath?.trim();
        if (localPath) internalCachePaths.add(localPath);
      }
    }
    await Promise.allSettled(
      [...internalCachePaths].map((path) => deleteCompositionRun(path)),
    );
    if (internalCreationIds.size > 0) {
      const toDelete = [...internalCreationIds];
      const results = await Promise.allSettled(
        toDelete.map((creationId) => deleteLocal(creationId)),
      );
      const deletedIds = toDelete.filter(
        (_, index) => results[index]?.status === "fulfilled",
      );
      if (deletedIds.length > 0) {
        removeCreationsFromOpenProject(deletedIds);
      }
    }
    for (const stream of streams) {
      removeOpenStillWorkstream(stream.id);
    }
    if (openCompositionId && ids.includes(openCompositionId)) {
      setOpenCompositionId(null);
    }
  };

  const deleteAssetsFromProjectAndLibrary = async (assetIds: string[]) => {
    const usedIds = assetsUsedOnTimeline(assetIds);
    if (usedIds.size > 0) {
      await confirm({
        title: usedIds.size === 1 ? "Asset in use" : "Assets in use",
        message:
          usedIds.size === 1
            ? "One selected asset is used on the timeline. Remove its clips first, then try again."
            : `${usedIds.size} selected assets are used on the timeline. Remove their clips first, then try again.`,
        confirmLabel: "OK",
        hideCancel: true,
      });
      return;
    }
    const count = assetIds.length;
    const ok = await confirm({
      title: count === 1 ? "Delete asset?" : `Delete ${count} assets?`,
      message:
        count === 1
          ? "Do you want to remove this from the project and also delete it from the library?"
          : `Do you want to remove these ${count} assets from the project and also delete them from the library?`,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    const results = await Promise.allSettled(
      assetIds.map((assetId) => deleteProjectAsset(project.id, assetId)),
    );
    const deletedIds = assetIds.filter(
      (_, index) => results[index]?.status === "fulfilled",
    );
    const failed = results.filter((result) => result.status === "rejected");
    if (deletedIds.length > 0) {
      removeCreationsFromOpenProject(deletedIds);
    }
    if (deletedIds.includes(selectedAssetId ?? "")) {
      setSelectedAssetId(null);
      setSelectedAssetIds([]);
      setOpenProjectSelectedAssetId(null);
    }
    if (failed.length > 0) {
      const first = failed[0];
      const detail =
        first?.status === "rejected"
          ? first.reason instanceof Error
            ? first.reason.message
            : String(first.reason)
          : "";
      await confirm({
        title:
          failed.length === 1
            ? "One asset could not be deleted"
            : `${failed.length} assets could not be deleted`,
        message: detail,
        confirmLabel: "OK",
        hideCancel: true,
      });
    }
  };

  const deleteMembersFromProjectGroup = async (opts: {
    groupId: string;
    kind: ProjectGroupKind;
    memberIds: string[];
  }) => {
    const usedIds = opts.memberIds.filter((id) =>
      timelineUsedAssetIds.has(id),
    );
    if (usedIds.length > 0) {
      await confirm({
        title: usedIds.length === 1 ? "Asset in use" : "Assets in use",
        message:
          usedIds.length === 1
            ? "This asset is used on the timeline. Remove its clips first, then try again."
            : `${usedIds.length} selected assets are used on the timeline. Remove their clips first, then try again.`,
        confirmLabel: "OK",
        hideCancel: true,
      });
      return;
    }

    const count = opts.memberIds.length;
    const groupLabel = opts.kind === "images" ? "Images" : "Videos";
    await confirm({
      title:
        count === 1
          ? `Delete from ${groupLabel} group?`
          : `Delete ${count} from ${groupLabel} group?`,
      message:
        count === 1
          ? `This will permanently delete the asset on Parascene and update the ${groupLabel} group in the cloud. This cannot be undone.`
          : `This will permanently delete these ${count} assets on Parascene and update the ${groupLabel} group in the cloud. This cannot be undone.`,
      confirmLabel: "Delete from group",
      cancelLabel: "Cancel",
      danger: true,
      errorTitle: "Could not delete from group",
      onConfirm: async ({ setMessage }) => {
        setMessage("Starting…");
        const result = await removeMembersFromProjectGroup({
          projectId: project.id,
          projectTitle: project.title,
          kind: opts.kind,
          groupId: opts.groupId,
          memberIds: opts.memberIds,
          onProgress: setMessage,
        });
        if (result.projectCreationIdsToRemove.length > 0) {
          removeCreationsFromOpenProject(result.projectCreationIdsToRemove);
        }
        if (result.projectCreationIdsToAdd.length > 0) {
          addCreationsToOpenProject(result.projectCreationIdsToAdd);
        }
        if (result.groupId === null) {
          setOpenProjectGroupIds(
            opts.kind === "images"
              ? { imagesGroupId: null }
              : { videosGroupId: null },
          );
        } else {
          setOpenProjectGroupIds(
            opts.kind === "images"
              ? { imagesGroupId: result.groupId }
              : { videosGroupId: result.groupId },
          );
        }
        if (
          selectedAssetId &&
          result.projectCreationIdsToRemove.includes(selectedAssetId)
        ) {
          setSelectedAssetId(null);
          setSelectedAssetIds([]);
          setOpenProjectSelectedAssetId(null);
        }
      },
    });
  };

  // Source monitor: assets panel selection, or the selected clip's source asset.
  // Timeline monitor owns the pane when active (no source asset loaded).
  const clipDraftAssetId = clipStagingSeed?.draft.assetId?.trim() || null;

  const selectedTimelineClip = useMemo(
    () => displayTimeline.find((clip) => clip.id === selectedClipId) ?? null,
    [displayTimeline, selectedClipId],
  );

  const selectedNeedsExtendBake = useMemo(() => {
    if (!selectedTimelineClip) return false;
    if (
      clipStagingSeed?.clipId === selectedTimelineClip.id &&
      clipStagingSeed.draft.kind === "video"
    ) {
      return clipNeedsExtendBake(
        applyDraftToTimelineClip(selectedTimelineClip, clipStagingSeed.draft),
      );
    }
    return clipNeedsExtendBake(selectedTimelineClip);
  }, [selectedTimelineClip, clipStagingSeed]);

  const addAssetMode =
    monitorMode === "source" &&
    (addAssetSlotActive ||
      (selectedTimelineClip != null &&
        isAddAssetPlaceholderClip(selectedTimelineClip)));

  const generateTargetClip = useMemo(() => {
    if (selectedClipId) {
      const clip = displayTimeline.find((c) => c.id === selectedClipId);
      if (clip && isAddAssetPlaceholderClip(clip)) return clip;
    }
    return displayTimeline.find(isAddAssetPlaceholderClip) ?? null;
  }, [displayTimeline, selectedClipId]);

  useEffect(() => {
    if (!addAssetGenerationSession) return;
    clearAddAssetGenerationIfClipMissing(
      project.timeline.map((clip) => clip.id),
    );
  }, [project.timeline, addAssetGenerationSession]);

  // After a background job finishes, refresh source staging if that clip is selected.
  useEffect(() => {
    const prev = prevAddAssetGenerationSessionRef.current;
    prevAddAssetGenerationSessionRef.current = addAssetGenerationSession;
    if (!prev || prev.phase !== "running" || addAssetGenerationSession) return;
    const clipId = prev.clipId;
    if (!selectedClipIdsRef.current.includes(clipId)) return;
    const realClip = project.timeline.find((clip) => clip.id === clipId);
    if (!realClip || isAddAssetPlaceholderClip(realClip)) return;
    const draft = timelineClipToStagedDraft(realClip);
    setClipStagingSeed(draft ? { clipId: realClip.id, draft } : null);
  }, [addAssetGenerationSession, project.timeline]);

  const addAssetGenerationByClipId = useMemo(() => {
    const map = new Map<string, BakeInfo>();
    for (const clip of project.timeline) {
      const err = clip.addAssetDraft?.lastError?.trim();
      if (!err || !isAddAssetPlaceholderClip(clip)) continue;
      map.set(clip.id, { status: "failed", error: err });
    }
    if (addAssetGenerationSession) {
      const status =
        addAssetGenerationSession.phase === "running"
          ? "generating"
          : "failed";
      map.set(addAssetGenerationSession.clipId, {
        status,
        error: addAssetGenerationSession.errorMessage,
      });
    }
    return map;
  }, [addAssetGenerationSession, project.timeline]);

  const startAddAssetGeneration = (request: StartAddAssetGenerationRequest) => {
    startAddAssetGenerationJob({
      projectId: project.id,
      request,
      runOpts: {
        timeline: timelineRef.current,
        mainAudioCreationId: editorMainAudioCreationId,
        lyricAlignment: project.lyricAlignment,
        aspectRatio: project.aspectRatio,
        projectId: project.id,
        projectTitle: project.title,
        imagesGroupId: project.imagesGroupId,
        videosGroupId: project.videosGroupId,
        boundFolderId: project.boundFolderId,
      },
    });
  };

  const retryAddAssetDownload = () => {
    const clip = generateTargetClip;
    if (!clip) return;
    const draft = clip.addAssetDraft;
    const modelId = draft?.replicateModel?.trim() || "";
    const errorText =
      addAssetGenerationSession?.errorMessage?.trim() ||
      draft?.lastError?.trim() ||
      "";

    void (async () => {
      let predictionId = draft?.replicatePredictionId?.trim() || "";
      if (!predictionId && isDownloadRetryableError(errorText)) {
        try {
          const rows = await replicatePredictionsList({});
          const match = rows.find((row) => {
            if (row.hasLocalOutputs) return false;
            const id = `${row.owner}/${row.name}`;
            if (modelId && id !== modelId) return false;
            const st = row.status.toLowerCase();
            return (
              st === "failed" ||
              st === "downloading" ||
              st === "succeeded"
            );
          });
          predictionId = match?.predictionId?.trim() || "";
        } catch {
          predictionId = "";
        }
      }
      if (!predictionId) {
        clearAddAssetGenerationError({
          projectId: project.id,
          clipId: clip.id,
        });
        return;
      }
      retryAddAssetDownloadJob({
        projectId: project.id,
        clipId: clip.id,
        predictionId,
        imagesGroupId: project.imagesGroupId,
        boundFolderId: project.boundFolderId,
        prompt: draft?.prompt?.trim() || "",
        lyricsText: "",
        audioMode: draft?.audioMode === "full_mix" ? "full_mix" : "vocals",
        continuityMode: draft?.continuityMode ?? "start_frame",
        durationSec: addAssetClipDurationSec(clip),
        modelId: modelId || "replicate",
      });
    })();
  };

  const duplicateGeneratedAsNewGenerate = (generation: AddAssetGeneration) => {
    const creationId = generation.creationId?.trim() || "";
    const matchedClip =
      (selectedTimelineClip?.addAssetGeneration?.creationId === creationId
        ? selectedTimelineClip
        : null) ??
      findTimelineGenerationForAsset(displayTimeline, creationId)?.clip ??
      findTimelineGenerationForAsset(displayTimeline, selectedAssetId)?.clip ??
      null;
    const draft = stagedDraftForDuplicateGenerate(
      generation,
      matchedClip
        ? addAssetClipDurationSec(matchedClip)
        : ADD_ASSET_TIMELINE_DURATION_SEC,
    );
    recordUiOpTrace({
      type: "place_at_end_click",
      kind: "image",
      reason: "duplicate_generated_as_new_generate",
    });
    window.dispatchEvent(
      new CustomEvent("parascene-staged-clip-place", {
        detail: { draft },
      }),
    );
  };

  const selectedAddAssetGeneration = useMemo(() => {
    if (selectedTimelineClip?.addAssetGeneration) {
      return selectedTimelineClip.addAssetGeneration;
    }
    // Assets-pane selection clears the clip, but provenance still lives on the
    // timeline clip that produced this creation.
    if (
      monitorMode === "source" &&
      selectedAssetId &&
      !clipStagingSeed &&
      !addAssetSlotActive
    ) {
      return (
        findTimelineGenerationForAsset(displayTimeline, selectedAssetId)
          ?.generation ?? null
      );
    }
    return null;
  }, [
    selectedTimelineClip,
    monitorMode,
    selectedAssetId,
    clipStagingSeed,
    addAssetSlotActive,
    displayTimeline,
  ]);

  const previewAssetId =
    monitorMode === "source"
      ? (selectedAssetId ??
          (clipStagingSeed?.draft.isAddAssetPlaceholder
            ? null
            : clipDraftAssetId))
      : null;

  return (
    <div ref={workspaceRef} className={workspaceClass} style={style}>
      {showAssetsPane ? (
        <AssetBrowserPane
          assets={project.assets}
          folders={projectFolders}
          imagesGroupId={project.imagesGroupId}
          videosGroupId={project.videosGroupId}
          filter={assetFilter}
          selectedId={selectedAssetId}
          selectedIds={selectedAssetIds}
          onFilterChange={setAssetFilter}
          onSelectionChange={selectAssets}
          onCollapse={collapseAssets}
          drawer={narrow}
          previewActive={
            monitorMode === "source" &&
            Boolean(selectedAssetId || addAssetSlotActive)
          }
          aspectRatio={project.aspectRatio}
          addSlotSelected={addAssetSlotActive}
          onAddSlotSelect={selectAddAssetSlot}
          onDeleteAssets={(ids) => {
            void deleteAssetsFromProjectAndLibrary(ids);
          }}
          onRemoveAssets={(ids) => {
            void removeAssetsFromProject(ids);
          }}
          onRemoveFolders={(ids) => {
            void removeFoldersFromProject(ids);
          }}
          boundFolderId={boundFolderId}
          boundMemberIds={boundFolder?.memberIds ?? []}
          boundFolderLocked={boundFolderLocked}
          onBindFolder={(folderId) => {
            void (async () => {
              if (boundFolderLocked) {
                await confirm({
                  title: "Working folder locked",
                  message:
                    "Timeline clips still use files from the current working folder. Remove those clips first, then try again.",
                  confirmLabel: "OK",
                  hideCancel: true,
                });
                return;
              }
              try {
                await setProjectBoundFolder(project.id, folderId);
                setOpenProjectBoundFolderId(folderId);
              } catch (error) {
                console.error("Failed to bind working folder", error);
              }
            })();
          }}
          onUnbindFolder={() => {
            void (async () => {
              if (boundFolderLocked) {
                await confirm({
                  title: "Working folder locked",
                  message:
                    "Timeline clips still use files from the working folder. Remove those clips first, then try again.",
                  confirmLabel: "OK",
                  hideCancel: true,
                });
                return;
              }
              await setProjectBoundFolder(project.id, null);
              setOpenProjectBoundFolderId(null);
            })();
          }}
          onDeleteFromGroup={(target) => {
            void deleteMembersFromProjectGroup(target);
          }}
          timelineUsedAssetIds={timelineUsedAssetIds}
          compositions={project.stillWorkstreams}
          openCompositionId={openCompositionId}
          onOpenComposition={(composition) => {
            setOpenCompositionId(composition.id);
            setAddAssetSlotActive(false);
          }}
          onDeleteCompositions={(ids) => {
            void deleteCompositionsFromProject(ids);
          }}
        />
      ) : null}

      {assetsDocked ? (
        <button
          type="button"
          className={
            dragging === "assets"
              ? "editor-splitter col assets is-dragging"
              : "editor-splitter col assets"
          }
          aria-label="Resize assets pane"
          onPointerDown={(e) => beginDrag("assets", e)}
        />
      ) : null}

      <PreviewPane
        assetId={previewAssetId}
        openCompositionId={openCompositionId}
        onOpenCompositionIdChange={setOpenCompositionId}
        addAssetMode={addAssetMode}
        addAssetSlotActive={addAssetSlotActive}
        addAssetIntent={addAssetIntent}
        onAddAssetIntentChange={setAddAssetIntent}
        addAssetPlaceholderClip={generateTargetClip}
        addAssetGenerationSession={addAssetGenerationSession}
        lyricAlignment={project.lyricAlignment}
        mainAudioCreationId={editorMainAudioCreationId}
        onStartAddAssetGeneration={startAddAssetGeneration}
        onAddAssetDurationChange={(durationSec) => {
          const clip = generateTargetClip;
          if (!clip) return;
          setOpenProjectTimeline((prev) => {
            const found = prev.some((c) => c.id === clip.id);
            recordUiOpTrace({
              type: "add_asset_duration_patch",
              clipId: clip.id,
              count: prev.length,
              reason: found
                ? `ok duration=${durationSec}`
                : "SKIP_MISSING_CLIP",
            });
            if (!found) return prev;
            const next = prev.map((c) =>
              c.id === clip.id ? withAddAssetDuration(c, durationSec) : c,
            );
            timelineRef.current = next;
            return next;
          });
        }}
        onAddAssetDraftChange={(draft) => {
          const clip = generateTargetClip;
          if (!clip) return;
          setOpenProjectTimeline((prev) => {
            const found = prev.some((c) => c.id === clip.id);
            recordUiOpTrace({
              type: "add_asset_draft_patch",
              clipId: clip.id,
              count: prev.length,
              reason: found ? "ok" : "SKIP_MISSING_CLIP",
            });
            if (!found) return prev;
            const next = prev.map((c) =>
              c.id === clip.id ? { ...c, addAssetDraft: draft } : c,
            );
            timelineRef.current = next;
            return next;
          });
        }}
        onClearAddAssetGenerationError={() =>
          clearAddAssetGenerationError({
            projectId: project.id,
            clipId: generateTargetClip?.id ?? "",
          })
        }
        onRetryAddAssetDownload={retryAddAssetDownload}
        imageAssets={project.assets.filter((asset) => asset.kind === "image")}
        selectedAssetIds={
          monitorMode === "source" && !clipStagingSeed
            ? selectedAssetIds
            : []
        }
        projectCabinets={{
          imagesGroupId: project.imagesGroupId,
          videosGroupId: project.videosGroupId,
        }}
        aspectRatio={project.aspectRatio}
        monitorMode={monitorMode}
        timelineClips={displayTimeline}
        timelinePlayheadSec={displayPlayheadSec}
        timelinePlaying={timelinePlaying && monitorMode === "timeline"}
        mediaSeekEpoch={mediaSeekEpoch}
        onTimelineTimeUpdate={onTimelineEngineTimeUpdate}
        stagingSeed={
          monitorMode === "source" ? (clipStagingSeed?.draft ?? null) : null
        }
        stagingSeedKey={
          monitorMode === "source" ? (clipStagingSeed?.clipId ?? null) : null
        }
        selectedClipAddAssetGeneration={selectedAddAssetGeneration}
        onDuplicateGeneratedAsNewGenerate={duplicateGeneratedAsNewGenerate}
        onClipDraftChange={onClipDraftChange}
        restoredSourceDraft={
          monitorMode === "source" && !clipStagingSeed
            ? pendingStagedDraft
            : null
        }
        onSourceDraftChange={
          monitorMode === "source" && !clipStagingSeed
            ? onSourceDraftChange
            : undefined
        }
        bakeInfo={clipStagingSeed ? (selectedBakeInfo ?? null) : null}
        bakeInfoByClipId={bakeInfoByClipId}
        onSlideshowRender={
          clipStagingSeed?.draft.kind === "slideshow"
            ? onSlideshowRender
            : null
        }
        onExtendBake={
          clipStagingSeed?.draft.kind === "video" && selectedNeedsExtendBake
            ? onExtendBake
            : null
        }
        needsExtendBake={selectedNeedsExtendBake}
        onClipBakeInfoChange={(clipId, info) => {
          setBakeInfoByClipId((prev) => {
            const next = new Map(prev);
            next.set(clipId, info);
            return next;
          });
        }}
        showAssetsExpand={!showAssetsPane}
        onExpandAssets={expandAssets}
        volume={previewVolume}
        onVolumeChange={setPreviewVolume}
        onToggleTimelinePlay={toggleTimelinePlaying}
      />

      {assistantDocked ? (
        <button
          type="button"
          className={
            dragging === "assistant"
              ? "editor-splitter col assistant is-dragging"
              : "editor-splitter col assistant"
          }
          aria-label="Resize assistant pane"
          onPointerDown={(e) => beginDrag("assistant", e)}
        />
      ) : null}

      {showAssistantPane ? (
        <AssistantPane onCollapse={collapseAssistant} drawer={narrow} />
      ) : (
        <button
          type="button"
          className="editor-pane-expand right"
          onClick={expandAssistant}
          title="Expand assistant"
          aria-label="Expand assistant"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              fill="currentColor"
              d="M13.8 12.8 9.5 8l4.3-4.8-1.1-1L7.4 8l5.3 5.8zm-5.2 0L3.3 8l4.3-4.8-1.1-1L1.2 8l5.3 5.8z"
            />
          </svg>
        </button>
      )}

      <button
        type="button"
        className={
          dragging === "timeline"
            ? "editor-splitter row timeline is-dragging"
            : "editor-splitter row timeline"
        }
        aria-label="Resize timeline"
        onPointerDown={(e) => beginDrag("timeline", e)}
      />

      <TimelinePane
        clips={displayTimeline}
        projectId={project.id}
        aspectRatio={project.aspectRatio}
        onClipsChange={onTimelineClipsChange}
        bakeInfoByClipId={bakeInfoByClipId}
        addAssetGenerationByClipId={addAssetGenerationByClipId}
        lyricAlignment={project.lyricAlignment}
        mainAudioCreationId={editorMainAudioCreationId}
        selectedClipIds={selectedClipIds}
        onSelectClip={selectClip}
        zoom={project.timelineZoom}
        onZoomChange={setOpenProjectTimelineZoom}
        monitorActive={monitorMode === "timeline"}
        onActivateMonitor={activateTimeline}
        playheadSec={displayPlayheadSec}
        onPlayheadChange={seekTimelinePlayhead}
        playing={timelinePlaying && monitorMode === "timeline"}
        onTogglePlay={toggleTimelinePlaying}
        volume={previewVolume}
        onVolumeChange={setPreviewVolume}
        canMergeSelected={Boolean(mergeSelection)}
        onMergeSelected={openMergeModal}
        mergeBusy={mergeModal?.phase === "running"}
        canJoinSelected={Boolean(joinPair)}
        onJoinSelected={openJoinStudio}
        joinBusy={joinStudioOpen}
      />

      {joinStudioOpen && joinStudioPair ? (
        <JoinStudioModal
          pair={joinStudioPair}
          onDone={closeJoinStudio}
          onCommitted={applyJoinCommit}
        />
      ) : null}

      {mergeModal ? (
        <TimelineMergeModal
          state={mergeModal}
          onCancel={closeMergeModal}
          onConfirm={() => {
            void runMergeSelectedClips();
          }}
          onDismissError={closeMergeModal}
        />
      ) : null}

      {showAssetsDrawer || showAssistantDrawer ? (
        <button
          type="button"
          className="editor-drawer-backdrop"
          aria-label="Close drawer"
          onClick={() => {
            setAssetsDrawerOpen(false);
            setAssistantDrawerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
