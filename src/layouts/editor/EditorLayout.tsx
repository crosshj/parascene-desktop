import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShell } from "../../app/ShellProvider";
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
import {
  applyDraftToTimelineClip,
  timelineClipToStagedDraft,
  type StagedClipDraft,
} from "./stagedClip";
import { TimelinePane } from "./TimelinePane";
import { timelineSequenceDuration } from "./timelineCompose";
import type { TimelineClip } from "../../project/types";

const NARROW_MQ = "(max-width: 1100px)";

function matchesNarrowViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(NARROW_MQ).matches;
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
    setOpenProjectTimeline,
    setOpenProjectSelectedTimelineClipId,
    setOpenProjectSelectedAssetId,
    setOpenProjectTimelineZoom,
    setOpenProjectTimelineMonitorActive,
    setOpenProjectTimelinePlayheadSec,
    leftCollapsed,
    rightCollapsed,
    toggleLeft,
    toggleRight,
  } = useShell();

  const [prefs, setPrefs] = useState<EditorLayoutPrefs>(() =>
    loadEditorLayoutPrefs(),
  );
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  /** Staging fields taken from the clicked timeline clip. */
  const [clipStagingSeed, setClipStagingSeed] = useState<{
    clipId: string;
    draft: StagedClipDraft;
  } | null>(null);
  const [assetFilter, setAssetFilter] = useState<AssetKindFilter>("all");
  const [narrow, setNarrow] = useState(matchesNarrowViewport);
  const [assetsDrawerOpen, setAssetsDrawerOpen] = useState(false);
  const [assistantDrawerOpen, setAssistantDrawerOpen] = useState(false);
  const [dragging, setDragging] = useState<DragKind | null>(null);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

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
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
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

  useEffect(() => {
    const savedClipId = project.selectedTimelineClipId;
    if (savedClipId) {
      const clip = project.timeline.find((c) => c.id === savedClipId);
      if (clip) {
        setSelectedAssetId(null);
        setSelectedClipId(clip.id);
        const draft = timelineClipToStagedDraft(clip);
        setClipStagingSeed(draft ? { clipId: clip.id, draft } : null);
        return;
      }
    }
    const savedAssetId = project.selectedAssetId;
    if (
      savedAssetId &&
      project.assets.some((asset) => asset.id === savedAssetId)
    ) {
      setSelectedClipId(null);
      setClipStagingSeed(null);
      setSelectedAssetId(savedAssetId);
      return;
    }
    setSelectedAssetId(null);
    setSelectedClipId(null);
    setClipStagingSeed(null);
  }, [project.id]);

  // Drop local selection if the clip was removed from the timeline.
  useEffect(() => {
    if (!selectedClipId) return;
    if (project.timeline.some((c) => c.id === selectedClipId)) return;
    setSelectedClipId(null);
    setClipStagingSeed(null);
  }, [project.timeline, selectedClipId]);

  // Drop local asset selection if the asset left the project.
  useEffect(() => {
    if (!selectedAssetId) return;
    if (project.assets.some((asset) => asset.id === selectedAssetId)) return;
    setSelectedAssetId(null);
  }, [project.assets, selectedAssetId]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!narrow) {
      setAssetsDrawerOpen(false);
      setAssistantDrawerOpen(false);
    }
  }, [narrow]);

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

  const selectAsset = (id: string) => {
    pauseTimelinePlayback();
    setSelectedClipId(null);
    setClipStagingSeed(null);
    setSelectedAssetId(id);
    setOpenProjectSelectedAssetId(id);
  };

  const selectClip = (clip: TimelineClip | null) => {
    pauseTimelinePlayback();
    if (!clip) {
      setSelectedClipId(null);
      setClipStagingSeed(null);
      setOpenProjectSelectedTimelineClipId(null);
      return;
    }
    // Clip instance ≠ asset selection — clear assets panel highlight.
    setSelectedAssetId(null);
    setSelectedClipId(clip.id);
    const draft = timelineClipToStagedDraft(clip);
    setClipStagingSeed(draft ? { clipId: clip.id, draft } : null);
    setOpenProjectSelectedTimelineClipId(clip.id);
  };

  const activateTimeline = () => {
    setSelectedClipId(null);
    setClipStagingSeed(null);
    setSelectedAssetId(null);
    setOpenProjectTimelineMonitorActive(true);
  };

  const onClipDraftChange = (clipId: string, draft: StagedClipDraft) => {
    setClipStagingSeed({ clipId, draft });
    const next = project.timeline.map((clip) =>
      clip.id === clipId ? applyDraftToTimelineClip(clip, draft) : clip,
    );
    setOpenProjectTimeline(next);
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
          filter={assetFilter}
          selectedId={selectedAssetId}
          onFilterChange={setAssetFilter}
          onSelect={selectAsset}
          onCollapse={collapseAssets}
          drawer={narrow}
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
        aspectRatio={project.aspectRatio}
        monitorMode={monitorMode}
        timelineClips={project.timeline}
        timelinePlayheadSec={displayPlayheadSec}
        timelineDurationSec={Math.max(
          60,
          sequenceDurationSec,
          displayPlayheadSec,
        )}
        timelinePlaying={timelinePlaying && monitorMode === "timeline"}
        mediaSeekEpoch={mediaSeekEpoch}
        onToggleTimelinePlay={toggleTimelinePlaying}
        onTimelinePlayheadChange={seekTimelinePlayhead}
        stagingSeed={
          monitorMode === "source" ? (clipStagingSeed?.draft ?? null) : null
        }
        stagingSeedKey={
          monitorMode === "source" ? (clipStagingSeed?.clipId ?? null) : null
        }
        onClipDraftChange={onClipDraftChange}
        showAssetsExpand={!showAssetsPane}
        onExpandAssets={expandAssets}
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
        >
          Assistant
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
        onClipsChange={setOpenProjectTimeline}
        selectedClipId={selectedClipId}
        onSelectClip={selectClip}
        zoom={project.timelineZoom}
        onZoomChange={setOpenProjectTimelineZoom}
        monitorActive={monitorMode === "timeline"}
        onActivateMonitor={activateTimeline}
        playheadSec={displayPlayheadSec}
        onPlayheadChange={seekTimelinePlayhead}
      />

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
