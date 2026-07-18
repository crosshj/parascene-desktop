import {
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
  deleteLocal,
  mergeTimelineClips,
  type MergeProgress,
} from "../../library/catalogClient";
import {
  listFolders,
  type LibraryFolder,
} from "../../library/folderClient";
import {
  ensureSlideshowMedia,
  formatBakeError,
  slideshowEnsureInputFromRecipe,
  type BakeInfo,
} from "../../library/slideshowMedia";
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
import {
  selectionFromProject,
  pendingDraftMatchesSelection,
} from "./editorSelection";
import {
  applyDraftToTimelineClip,
  newSlideshowSeed,
  slideshowRecipesEqual,
  timelineClipToStagedDraft,
  type StagedClipDraft,
} from "./stagedClip";
import { TimelinePane } from "./TimelinePane";
import { timelineSequenceDuration } from "./timelineCompose";
import { getMergeableTimelineSelection } from "./timelineMerge";
import {
  TimelineMergeModal,
  type TimelineMergeModalState,
} from "./TimelineMergeModal";
import {
  isBeatSlideshowMode,
  type TimelineClip,
} from "../../project/types";
import { useConfirm } from "../../ui/ConfirmDialog";

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
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
    setOpenProjectSelectedAssetId,
    setOpenProjectPendingStagedDraft,
    setOpenProjectTimelineZoom,
    setOpenProjectTimelineMonitorActive,
    setOpenProjectTimelinePlayheadSec,
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
  const [projectFolders, setProjectFolders] = useState<LibraryFolder[]>([]);
  const [mergeModal, setMergeModal] = useState<TimelineMergeModalState | null>(
    null,
  );
  const [narrow, setNarrow] = useState(matchesNarrowViewport);
  const [assetsDrawerOpen, setAssetsDrawerOpen] = useState(false);
  const [assistantDrawerOpen, setAssistantDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  /** Internal clipboard for Cmd/Ctrl+C / Cmd/Ctrl+V of timeline clips. */
  const clipClipboardRef = useRef<TimelineClip[]>([]);
  const mergeRunningRef = useRef(false);

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
  const sequenceDurationSec = timelineSequenceDuration(project.timeline);
  /**
   * While playing, playhead is local (avoids localStorage writes every frame).
   * When paused, the persisted project playhead is the source of truth.
   */
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [livePlayheadSec, setLivePlayheadSec] = useState(
    project.timelinePlayheadSec,
  );
  /** Bumped on scrub-while-playing / loop so media re-primes without pausing. */
  const [mediaSeekEpoch, setMediaSeekEpoch] = useState(0);
  const livePlayheadRef = useRef(project.timelinePlayheadSec);
  const displayPlayheadSec = timelinePlaying
    ? livePlayheadSec
    : project.timelinePlayheadSec;
  const mergeSelection = useMemo(
    () => getMergeableTimelineSelection(project.timeline, selectedClipIds),
    [project.timeline, selectedClipIds],
  );

  const projectFolderIdsKey = project.folderIds.join("\0");

  if (project.folderIds.length === 0 && projectFolders.length > 0) {
    setProjectFolders([]);
  }

  useEffect(() => {
    if (project.folderIds.length === 0) return;
    const wanted = new Set(project.folderIds);
    let cancelled = false;
    void (async () => {
      try {
        const all = await listFolders();
        if (cancelled) return;
        setProjectFolders(all.filter((folder) => wanted.has(folder.id)));
      } catch (error) {
        console.error("Failed to load project folders", error);
        if (!cancelled) setProjectFolders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectFolderIdsKey, project.assets.length, project.folderIds]);

  const pauseTimelinePlayback = () => {
    if (!timelinePlaying) return;
    setTimelinePlaying(false);
    setOpenProjectTimelinePlayheadSec(livePlayheadRef.current);
  };

  // Virtual timeline clock — only while the program monitor is active.
  useEffect(() => {
    if (!timelinePlaying || monitorMode !== "timeline") return;
    const end = Math.max(sequenceDurationSec, 0);
    if (end <= 0) return;

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const advanced = livePlayheadRef.current + dt;
      // Loop by default — wrap at sequence end.
      const wrapped = advanced >= end;
      const next = wrapped ? advanced % end : advanced;
      livePlayheadRef.current = next;
      setLivePlayheadSec(next);
      if (wrapped) setMediaSeekEpoch((n) => n + 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setOpenProjectTimelinePlayheadSec(livePlayheadRef.current);
    };
  }, [
    timelinePlaying,
    monitorMode,
    sequenceDurationSec,
    setOpenProjectTimelinePlayheadSec,
  ]);

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
    if (monitorMode !== "timeline") return;
    if (timelinePlaying) {
      pauseTimelinePlayback();
      return;
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

  // Space toggles play/pause while the program monitor owns the preview.
  useEffect(() => {
    if (monitorMode !== "timeline") return;

    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableKeyboardTarget(event.target)) return;
      event.preventDefault();
      toggleTimelinePlaying();
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    monitorMode,
    timelinePlaying,
    sequenceDurationSec,
    project.timelinePlayheadSec,
  ]);

  // Delete / Backspace removes selected timeline clips after confirm.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (selectedClipIds.length === 0) return;
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
  }, [
    selectedClipIds,
    project.timeline,
    confirm,
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
    timelinePlaying,
  ]);

  // Cmd/Ctrl+C copies selected clips; Cmd/Ctrl+V pastes at the playhead.
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
      const playhead = Math.max(
        0,
        timelinePlaying ? livePlayheadRef.current : project.timelinePlayheadSec,
      );
      const origin = Math.min(...sources.map((c) => c.startSec));
      const pasted = sources.map((source) => {
        const duration = Math.max(0.1, source.endSec - source.startSec);
        const startSec = playhead + (source.startSec - origin);
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
  }, [
    selectedClipIds,
    project.timeline,
    project.timelinePlayheadSec,
    timelinePlaying,
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

  // Drop local asset selections if assets left the project.
  if (selectedAssetIds.length > 0 || selectedAssetId) {
    const alive = new Set(project.assets.map((asset) => asset.id));
    const next = selectedAssetIds.filter((id) => alive.has(id));
    const assetSelectionStale =
      next.length !== selectedAssetIds.length ||
      (selectedAssetId !== null && !alive.has(selectedAssetId));
    if (assetSelectionStale) {
      const primary =
        selectedAssetId && next.includes(selectedAssetId)
          ? selectedAssetId
          : (next[next.length - 1] ?? null);
      setSelectedAssetIds(next);
      setSelectedAssetId(primary);
      setOpenProjectSelectedAssetId(primary);
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

  useEffect(() => {
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
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(null);
      saveEditorLayoutPrefs(prefsRef.current);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const beginDrag = (
    kind: DragKind,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
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
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setClipStagingSeed(null);
    setSelectedAssetIds(ids);
    setSelectedAssetId(primaryId);
    setOpenProjectSelectedAssetId(primaryId);
    if (!pendingDraftMatchesSelection(pendingStagedDraft, ids)) {
      clearPendingStagedDraft();
    }
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
    clearPendingStagedDraft();
    setOpenProjectTimelineMonitorActive(true);
  };

  const [bakeInfoByClipId, setBakeInfoByClipId] = useState<
    Map<string, BakeInfo>
  >(() => new Map());
  const bakeInflightRef = useRef<Set<string>>(new Set());
  const timelineRef = useRef(project.timeline);
  const aspectRatioRef = useRef(project.aspectRatio);

  useEffect(() => {
    timelineRef.current = project.timeline;
    aspectRatioRef.current = project.aspectRatio;
  }, [project.timeline, project.aspectRatio]);

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
        setOpenProjectTimeline(
          timelineRef.current.map((row) =>
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

  // Rebind beat-sync audio from current overlap (does not bake).
  useEffect(() => {
    let changed = false;
    const rebound = project.timeline.map((clip) => {
      if (
        clip.kind !== "slideshow" ||
        clip.bakePath?.trim() ||
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
      setBakeInfoByClipId((prev) => {
        const next = new Map(prev);
        for (let i = 0; i < rebound.length; i += 1) {
          const before = project.timeline[i];
          const after = rebound[i];
          if (
            before &&
            after &&
            before.id === after.id &&
            !slideshowRecipesEqual(before.slideshow, after.slideshow)
          ) {
            next.delete(after.id);
            bakeInflightRef.current.delete(after.id);
          }
        }
        return next;
      });
      setOpenProjectTimeline(rebound);
      setClipStagingSeed((prev) => {
        if (!prev) return prev;
        const updated = rebound.find((c) => c.id === prev.clipId);
        if (!updated) return prev;
        const draft = timelineClipToStagedDraft(updated);
        return draft ? { clipId: updated.id, draft } : prev;
      });
      return;
    }

    for (const clip of project.timeline) {
      if (clip.kind !== "slideshow" || !clip.slideshow) continue;
      if (!clip.bakePath?.trim()) continue;
      setBakeInfoByClipId((prev) => {
        if (prev.get(clip.id)?.status === "ready") return prev;
        const next = new Map(prev);
        next.set(clip.id, { status: "ready", error: null });
        return next;
      });
    }
    // Intentionally keyed on timeline identity + bake-sensitive fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project.id,
    project.aspectRatio,
    project.timeline
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
      .join("|"),
    // Audio clip identity/trims affect beat rebind even when slideshow rows are unchanged.
    project.timeline
      .filter((c) => c.lane === "audio" || c.kind === "audio")
      .map(
        (c) =>
          `${c.id}:${c.assetId ?? ""}:${c.startSec}:${c.endSec}:${c.inSec ?? ""}:${c.outSec ?? ""}`,
      )
      .join("|"),
  ]);

  const onClipDraftChange = (clipId: string, draft: StagedClipDraft) => {
    setClipStagingSeed({ clipId, draft });
    const next = project.timeline.map((clip) =>
      clip.id === clipId ? applyDraftToTimelineClip(clip, draft) : clip,
    );
    setOpenProjectTimeline(next);
    const updated = next.find((clip) => clip.id === clipId);
    if (updated?.kind === "slideshow" && !updated.bakePath) {
      bakeInflightRef.current.delete(clipId);
      setBakeInfoByClipId((prev) => {
        const map = new Map(prev);
        map.delete(clipId);
        return map;
      });
    }
  };

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

  const selectedBakeInfo =
    selectedClipId != null ? bakeInfoByClipId.get(selectedClipId) : undefined;

  const openMergeModal = () => {
    if (!mergeSelection || mergeRunningRef.current) return;
    setMergeModal({
      phase: "confirm",
      clipCount: mergeSelection.clips.length,
    });
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
    }
    return used;
  };

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
      assetIds.map((assetId) => deleteLocal(assetId)),
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

  // Source monitor: assets panel selection, or the selected clip's source asset.
  // Timeline monitor owns the pane when active (no source asset loaded).
  const previewAssetId =
    monitorMode === "source"
      ? (selectedAssetId ?? clipStagingSeed?.draft.assetId ?? null)
      : null;

  return (
    <div ref={workspaceRef} className={workspaceClass} style={style}>
      {showAssetsPane ? (
        <AssetBrowserPane
          assets={project.assets}
          folders={projectFolders}
          filter={assetFilter}
          selectedId={selectedAssetId}
          selectedIds={selectedAssetIds}
          onFilterChange={setAssetFilter}
          onSelectionChange={selectAssets}
          onCollapse={collapseAssets}
          drawer={narrow}
          previewActive={
            monitorMode === "source" && Boolean(selectedAssetId)
          }
          onDeleteAssets={(ids) => {
            void deleteAssetsFromProjectAndLibrary(ids);
          }}
          onRemoveAssets={(ids) => {
            void removeAssetsFromProject(ids);
          }}
          onRemoveFolders={(ids) => {
            void removeFoldersFromProject(ids);
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
        selectedAssetIds={
          monitorMode === "source" && !clipStagingSeed
            ? selectedAssetIds
            : []
        }
        aspectRatio={project.aspectRatio}
        monitorMode={monitorMode}
        timelineClips={project.timeline}
        timelinePlayheadSec={displayPlayheadSec}
        timelinePlaying={timelinePlaying && monitorMode === "timeline"}
        mediaSeekEpoch={mediaSeekEpoch}
        stagingSeed={
          monitorMode === "source" ? (clipStagingSeed?.draft ?? null) : null
        }
        stagingSeedKey={
          monitorMode === "source" ? (clipStagingSeed?.clipId ?? null) : null
        }
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
        showAssetsExpand={!showAssetsPane}
        onExpandAssets={expandAssets}
        volume={previewVolume}
        onVolumeChange={setPreviewVolume}
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
        clips={project.timeline}
        projectId={project.id}
        aspectRatio={project.aspectRatio}
        onClipsChange={setOpenProjectTimeline}
        bakeInfoByClipId={bakeInfoByClipId}
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
      />

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
