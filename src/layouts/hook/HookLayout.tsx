import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";
import { useShell } from "../../app/ShellProvider";
import { projectAspectCss } from "../../project/aspectRatios";
import { enabledLookLabels } from "../../project/looks";
import {
  deleteTimelineRender,
  exportTimelineRender,
  exportTimelineRenderAudio,
  listTimelineRenders,
  ensureRenderMediaLocal,
  startTimelineRender,
  timelineClipsToRenderInput,
  type RenderFinished,
  type RenderProgress,
  type TimelineRender,
} from "../../publisher/renderClient";
import { timelineSequenceDuration } from "../editor/timelineCompose";
import { rebuildReversed } from "../../library/catalogClient";
import { invalidateClipThumbnails } from "../../library/clipThumbnail";
import { invalidateReversedMedia } from "../../library/reversedMedia";
import { useConfirm } from "../../ui/ConfirmDialog";
import {
  PublisherRenderModal,
  type PublisherRenderModalState,
} from "./PublisherRenderModal";
import {
  describeRenderProgress,
  HookRenderDetailsPane,
  renderProgressPercent as liveRenderProgressPercent,
} from "./HookRenderDetailsPane";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const tenths = Math.floor((sec % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
}

function formatRenderStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderVideoSrc(render: TimelineRender | null): string | null {
  if (!render?.path || render.status !== "ready") return null;
  try {
    // Use a dedicated Range-capable scheme. asset:// mid-stream freezes are a
    // known WebKit/Tauri footgun for larger MP4s (looks like decode corruption).
    return convertFileSrc(render.path, "media");
  } catch {
    return null;
  }
}

function renderProgressPercent(progress: RenderProgress | null): number {
  return liveRenderProgressPercent(progress);
}

function renderProgressLabel(progress: RenderProgress | null): string {
  return describeRenderProgress(progress);
}

function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(target.tagName) ||
    target.isContentEditable
  );
}

export function HookLayout() {
  const { project } = useShell();
  const confirm = useConfirm();
  const sequenceDurationSec = timelineSequenceDuration(project.timeline);
  const [renders, setRenders] = useState<TimelineRender[]>([]);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [rendersBusy, setRendersBusy] = useState(false);
  const [renderModal, setRenderModal] = useState<PublisherRenderModalState | null>(
    null,
  );
  const [viewerMode, setViewerMode] = useState<"player" | "details">("player");
  const [exportingRenderId, setExportingRenderId] = useState<string | null>(null);
  const [exportingKind, setExportingKind] = useState<"video" | "audio" | null>(
    null,
  );
  const [rebuildingCache, setRebuildingCache] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [volume, setVolume] = useState(80);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playheadRef = useRef(0);
  const focusVideoAfterRenderRef = useRef(false);
  const openDetailsOnNextInProgressRef = useRef(false);

  const hasTimeline = project.timeline.length > 0;
  const renderInProgress = renders.some((render) => render.status === "rendering");
  const selectedRender =
    renders.find((render) => render.id === selectedRenderId) ?? null;
  const selectedRendering = selectedRender?.status === "rendering";
  const activeDurationSec = selectedRender?.durationSec ?? sequenceDurationSec;
  const activeVideoSrc = selectedRendering
    ? null
    : renderVideoSrc(selectedRender);

  const [, startRendersTransition] = useTransition();

  const refreshRenders = useCallback(async () => {
    try {
      const rows = await listTimelineRenders(project.id);
      startRendersTransition(() => {
        setRenders(rows);
        setSelectedRenderId((current) => {
          if (
            current &&
            rows.some(
              (row) =>
                row.id === current &&
                (row.status === "ready" || row.status === "rendering"),
            )
          ) {
            return current;
          }
          return (
            rows.find((row) => row.status === "rendering")?.id ??
            rows.find((row) => row.status === "ready")?.id ??
            null
          );
        });
      });
    } catch (error) {
      console.error("Failed to list timeline renders", error);
    } finally {
      setRendersBusy(false);
    }
  }, [project.id, startRendersTransition]);

  const [rendersProjectId, setRendersProjectId] = useState<string | null>(null);
  if (project.id !== rendersProjectId) {
    setRendersProjectId(project.id);
    setRendersBusy(true);
  }

  useEffect(() => {
    let cancelled = false;
    let raf2 = 0;
    let timeoutId = 0;
    // Let Publisher chrome paint before the list IPC round-trip.
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        timeoutId = window.setTimeout(() => {
          void (async () => {
            try {
              const rows = await listTimelineRenders(project.id);
              if (cancelled) return;
              startRendersTransition(() => {
                setRenders(rows);
                setSelectedRenderId((current) => {
                  if (
                    current &&
                    rows.some((row) => row.id === current && row.status === "ready")
                  ) {
                    return current;
                  }
                  return rows.find((row) => row.status === "ready")?.id ?? null;
                });
              });
            } catch (error) {
              console.error("Failed to list timeline renders", error);
            } finally {
              if (!cancelled) setRendersBusy(false);
            }
          })();
        }, 0);
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.clearTimeout(timeoutId);
    };
  }, [project.id, startRendersTransition]);

  // Background heal may promote abandoned jobs shortly after list — refresh once.
  useEffect(() => {
    const id = window.setTimeout(() => {
      void refreshRenders();
    }, 1200);
    return () => window.clearTimeout(id);
  }, [project.id, refreshRenders]);

  useEffect(() => {
    playheadRef.current = playheadSec;
  }, [playheadSec]);

  const [playbackSourceKey, setPlaybackSourceKey] = useState(
    () => `${selectedRenderId ?? ""}:${activeVideoSrc ?? ""}`,
  );
  const nextPlaybackSourceKey = `${selectedRenderId ?? ""}:${activeVideoSrc ?? ""}`;
  if (nextPlaybackSourceKey !== playbackSourceKey) {
    setPlaybackSourceKey(nextPlaybackSourceKey);
    setPlaying(false);
    setPlayheadSec(0);
  }

  useEffect(() => {
    playheadRef.current = 0;
    const el = videoRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
  }, [selectedRenderId, activeVideoSrc]);

  useEffect(() => {
    if (!focusVideoAfterRenderRef.current) return;
    if (viewerMode !== "player" || !activeVideoSrc) return;
    focusVideoAfterRenderRef.current = false;
    videoRef.current?.focus({ preventScroll: true });
  }, [viewerMode, activeVideoSrc, selectedRenderId]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume, activeVideoSrc]);

  const seekTo = useCallback(
    (sec: number) => {
      const end = Math.max(activeDurationSec, 0.1);
      const next = Math.max(0, Math.min(end, sec));
      playheadRef.current = next;
      setPlayheadSec(next);
      const el = videoRef.current;
      if (el) {
        try {
          el.currentTime = next;
        } catch {
          // ignore
        }
      }
    },
    [activeDurationSec],
  );

  const togglePlay = useCallback(() => {
    if (!activeVideoSrc || activeDurationSec <= 0) return;
    const el = videoRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    if (playheadSec >= activeDurationSec - 0.05) {
      playheadRef.current = 0;
      setPlayheadSec(0);
      el.currentTime = 0;
    } else if (playheadRef.current === 0 && el.currentTime > 0.05) {
      el.currentTime = 0;
    }
    void el.play().catch(() => {});
    setPlaying(true);
  }, [activeDurationSec, activeVideoSrc, playheadSec, playing]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;

    void listen<RenderProgress>("publisher-render-progress", (event) => {
      if (event.payload.projectId !== project.id) return;
      setRenders((current) => {
        const index = current.findIndex(
          (render) => render.id === event.payload.renderId,
        );
        if (index < 0) {
          void refreshRenders();
          return current;
        }
        return current.map((render, i) =>
          i === index
            ? { ...render, status: "rendering", progress: event.payload }
            : render,
        );
      });
      if (openDetailsOnNextInProgressRef.current && event.payload.renderId) {
        openDetailsOnNextInProgressRef.current = false;
        setSelectedRenderId(event.payload.renderId);
        setViewerMode("details");
        setPlaying(false);
      }
    }).then((fn) => {
      unlistenProgress = fn;
    });

    void listen<RenderFinished>("publisher-render-finished", (event) => {
      if (event.payload.projectId !== project.id) return;
      if (event.payload.ok && event.payload.renderId) {
        focusVideoAfterRenderRef.current = true;
        setSelectedRenderId(event.payload.renderId);
        setViewerMode("player");
        setPlaying(false);
      } else if (event.payload.renderId) {
        setSelectedRenderId(event.payload.renderId);
        setViewerMode("details");
      }
      void refreshRenders();
    }).then((fn) => {
      unlistenFinished = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, [project.id, refreshRenders]);

  // Poll while any row is rendering so a missed event / mid-render list heal
  // cannot leave the UI frozen on "Starting FFmpeg…".
  useEffect(() => {
    if (!renders.some((render) => render.status === "rendering")) return;
    const id = window.setInterval(() => {
      void refreshRenders();
    }, 2000);
    return () => window.clearInterval(id);
  }, [renders, refreshRenders]);

  useEffect(() => {
    if (!activeVideoSrc || renderModal || viewerMode === "details") return;

    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isInteractiveKeyboardTarget(event.target)) return;

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlay();
        return;
      }

      const step = event.shiftKey ? 5 : 1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekTo(playheadRef.current - step);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekTo(playheadRef.current + step);
      } else if (event.key === "Home") {
        event.preventDefault();
        seekTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        seekTo(activeDurationSec);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeDurationSec,
    activeVideoSrc,
    renderModal,
    seekTo,
    togglePlay,
    viewerMode,
  ]);

  const startRender = () => {
    if (!hasTimeline || renderModal) return;
    setRenderModal({
      phase: "confirm",
      clipCount: project.timeline.length,
      lookLabels: enabledLookLabels(project.looks),
    });
  };

  const reversedAssetIds = Array.from(
    new Set(
      project.timeline
        .filter((clip) => clip.reverse && clip.assetId?.trim())
        .map((clip) => clip.assetId!.trim()),
    ),
  );

  const rebuildCache = async () => {
    if (rebuildingCache) return;
    setCacheStatus(null);
    if (reversedAssetIds.length === 0) {
      setCacheStatus("No reversed clips in this project.");
      return;
    }
    setRebuildingCache(true);
    try {
      const count = await rebuildReversed(reversedAssetIds);
      invalidateReversedMedia(reversedAssetIds);
      invalidateClipThumbnails(reversedAssetIds);
      setCacheStatus(
        count === 1 ? "Rebuilt 1 reversed clip." : `Rebuilt ${count} reversed clips.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Rebuild failed.";
      setCacheStatus(message);
      console.error(message);
    } finally {
      setRebuildingCache(false);
    }
  };

  const runRender = async () => {
    if (!hasTimeline) return;
    const clips = timelineClipsToRenderInput(project.timeline);
    const lookLabels = enabledLookLabels(project.looks);
    setRenderModal(null);
    openDetailsOnNextInProgressRef.current = true;
    try {
      await ensureRenderMediaLocal(clips);
      await startTimelineRender(
        project.id,
        project.aspectRatio,
        clips,
        project.looks,
      );
      for (let i = 0; i < 30; i += 1) {
        const rows = await listTimelineRenders(project.id);
        const rendering = rows.find((row) => row.status === "rendering");
        if (rendering) {
          setRenders(rows);
          if (openDetailsOnNextInProgressRef.current) {
            openDetailsOnNextInProgressRef.current = false;
            setSelectedRenderId(rendering.id);
            setViewerMode("details");
            setPlaying(false);
          }
          return;
        }
        await new Promise((resolve) => {
          window.setTimeout(resolve, 200);
        });
      }
      await refreshRenders();
    } catch (error) {
      openDetailsOnNextInProgressRef.current = false;
      const message =
        error instanceof Error ? error.message : "Could not start timeline render.";
      setRenderModal({
        phase: "error",
        clipCount: project.timeline.length,
        lookLabels,
        message,
      });
    }
  };

  const deleteRender = async (render: TimelineRender) => {
    const ok = await confirm({
      title: "Delete render?",
      message:
        "Removes this scratch render from the list and deletes the file from disk.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTimelineRender(project.id, render.id);
      if (selectedRenderId === render.id) {
        setSelectedRenderId(null);
        setPlaying(false);
        setViewerMode("player");
      }
      await refreshRenders();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not delete render.";
      await confirm({
        title: "Delete failed",
        message,
        confirmLabel: "OK",
        hideCancel: true,
      });
      console.error(message);
    }
  };

  const saveRenderToDisk = async (
    render: TimelineRender,
    kind: "video" | "audio" = "video",
  ) => {
    if (exportingRenderId) return;
    setExportingRenderId(render.id);
    setExportingKind(kind);
    try {
      const result =
        kind === "audio"
          ? await exportTimelineRenderAudio(
              project.id,
              render.id,
              project.title,
            )
          : await exportTimelineRender(project.id, render.id, project.title);
      if (result.cancelled) return;
      if (result.path) {
        try {
          await revealItemInDir(result.path);
          return;
        } catch (revealError) {
          console.error("Could not reveal saved file", revealError);
        }
      }
      await confirm({
        title: "Saved",
        message: result.path
          ? `${kind === "audio" ? "MP3" : "Render"} saved to:\n${result.path}`
          : kind === "audio"
            ? "MP3 saved."
            : "Render saved.",
        confirmLabel: "OK",
        hideCancel: true,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : kind === "audio"
            ? "Could not save MP3."
            : "Could not save render.";
      await confirm({
        title: "Save failed",
        message,
        confirmLabel: "OK",
        hideCancel: true,
      });
      console.error(message);
    } finally {
      setExportingRenderId(null);
      setExportingKind(null);
    }
  };

  const scrubMax = Math.max(activeDurationSec, 0.1);
  const scrubProgress =
    activeDurationSec > 0
      ? Math.min(100, Math.max(0, (playheadSec / activeDurationSec) * 100))
      : 0;

  const surfaceStyle = {
    aspectRatio: projectAspectCss(
      (selectedRender?.aspectRatio as typeof project.aspectRatio) ??
        project.aspectRatio,
    ),
  } as CSSProperties;

  return (
    <div className="layout hook">
      <section className="hook-preview" aria-label="Timeline render preview">
        {viewerMode === "details" && selectedRender ? (
          <HookRenderDetailsPane
            projectId={project.id}
            render={selectedRender}
            onClose={() => setViewerMode("player")}
          />
        ) : (
          <div className="hook-player">
            <div className="hook-player-frame">
              <div className="hook-player-surface" style={surfaceStyle}>
              {selectedRendering ? (
                <div
                  className="hook-player-empty hook-player-rendering"
                  aria-live="polite"
                  aria-busy="true"
                  aria-label="Rendering"
                >
                  <span className="confirm-dialog-spinner" aria-hidden />
                </div>
              ) : activeVideoSrc ? (
                <video
                  ref={videoRef}
                  className="hook-player-video"
                  src={activeVideoSrc}
                  playsInline
                  preload="auto"
                  tabIndex={-1}
                  onTimeUpdate={(event) => {
                    const next = event.currentTarget.currentTime;
                    playheadRef.current = next;
                    setPlayheadSec(next);
                  }}
                  onEnded={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
              ) : (
                <p className="muted hook-player-empty">
                  {hasTimeline
                    ? "Render the timeline to preview an FFmpeg output here. Scratch renders stay on disk but are not added to the library."
                    : "No clips on the timeline yet. Build a sequence in the Editor, then come back here to render it."}
                </p>
              )}
            </div>
          </div>

          <div
            className="hook-player-transport editor-preview-deck"
            aria-label="Publisher playback controls"
          >
            <input
              type="range"
              className="editor-transport-scrub"
              min={0}
              max={scrubMax}
              step={0.01}
              value={Math.min(playheadSec, scrubMax)}
              disabled={!activeVideoSrc}
              aria-label="Seek render"
              style={
                {
                  ["--scrub-progress" as string]: `${scrubProgress}%`,
                } as CSSProperties
              }
              onChange={(event) => seekTo(Number(event.target.value))}
            />

            <div className="editor-preview-deck-body">
              <div className="editor-preview-deck-row is-timeline-transport">
                <span className="editor-transport-tc">
                  {formatClock(playheadSec)} / {formatClock(activeDurationSec)}
                </span>

                <div
                  className="editor-transport-icons"
                  aria-label="Playback controls"
                >
                  <button
                    type="button"
                    className="editor-transport-icon"
                    disabled={!activeVideoSrc}
                    title="Skip to beginning (Home)"
                    aria-label="Skip to beginning"
                    onClick={() => seekTo(0)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M2.5 3h1.5v10H2.5zm2.5 5 8-5v10z"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="editor-transport-icon"
                    disabled={!activeVideoSrc}
                    title="Rewind 1 second (←)"
                    aria-label="Rewind 1 second"
                    onClick={() => seekTo(playheadRef.current - 1)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M3 8 9 3v3.2L14 3v10l-5-3.2V13z"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="editor-transport-icon is-play"
                    disabled={!activeVideoSrc}
                    title={`${playing ? "Pause" : "Play"} (Space)`}
                    aria-label={playing ? "Pause" : "Play"}
                    onClick={togglePlay}
                  >
                    {playing ? (
                      <svg viewBox="0 0 16 16" aria-hidden>
                        <path
                          fill="currentColor"
                          d="M4 3h3v10H4zm5 0h3v10H9z"
                        />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" aria-hidden>
                        <path fill="currentColor" d="M4 2.5v11l10-5.5z" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    className="editor-transport-icon"
                    disabled={!activeVideoSrc}
                    title="Forward 1 second (→)"
                    aria-label="Forward 1 second"
                    onClick={() => seekTo(playheadRef.current + 1)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        fill="currentColor"
                        d="m13 8-6-5v3.2L2 3v10l5-3.2V13z"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="editor-transport-icon"
                    disabled={!activeVideoSrc}
                    title="Skip to end (End)"
                    aria-label="Skip to end"
                    onClick={() => seekTo(activeDurationSec)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden>
                      <path
                        fill="currentColor"
                        d="m3 3 8 5-8 5zm9 0h1.5v10H12z"
                      />
                    </svg>
                  </button>
                </div>

                <div className="editor-transport-utils">
                  <label
                    className={`editor-transport-volume${
                      activeVideoSrc ? "" : " is-disabled"
                    }`}
                  >
                    <svg
                      className="editor-transport-volume-icon"
                      viewBox="0 0 16 16"
                      aria-hidden
                    >
                      <path
                        fill="currentColor"
                        d="M2 6h3l3-3v10l-3-3H2zm8.2 1.2a2.2 2.2 0 0 1 0 1.6l-.8-.5a1.2 1.2 0 0 0 0-.6zm1.6-2a4.2 4.2 0 0 1 0 5.6l-.8-.5a3.2 3.2 0 0 0 0-4.6z"
                      />
                    </svg>
                    <span className="visually-hidden">Volume</span>
                    <input
                      type="range"
                      className="editor-transport-scrub"
                      min={0}
                      max={100}
                      value={volume}
                      disabled={!activeVideoSrc}
                      aria-label="Volume"
                      style={
                        {
                          ["--scrub-progress" as string]: `${volume}%`,
                        } as CSSProperties
                      }
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setVolume(next);
                        const el = videoRef.current;
                        if (el) {
                          el.volume = Math.max(0, Math.min(1, next / 100));
                        }
                      }}
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
      </section>

      <aside className="hook-side">
        <h2>Publisher</h2>
        <p className="muted hook-side-copy">
          Scratch renders use FFmpeg to bake the current timeline. Files live on
          disk under Cache/renders and are not added to the library.
        </p>
        <dl className="hook-side-meta">
          <div>
            <dt>Clips</dt>
            <dd>{project.timeline.length}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatClock(sequenceDurationSec)}</dd>
          </div>
          <div>
            <dt>Aspect</dt>
            <dd>{project.aspectRatio}</dd>
          </div>
        </dl>

        <button
          type="button"
          className="btn primary hook-render-btn"
          disabled={!hasTimeline || Boolean(renderModal) || renderInProgress}
          onClick={startRender}
        >
          {renderInProgress ? "Rendering in background…" : "Render timeline"}
        </button>

        <button
          type="button"
          className="btn ghost hook-rebuild-btn"
          disabled={
            rebuildingCache || Boolean(renderModal) || reversedAssetIds.length === 0
          }
          onClick={() => void rebuildCache()}
          title="Force-regenerate reversed clip cache for this project"
        >
          {rebuildingCache
            ? "Rebuilding cache…"
            : `Rebuild reversed cache${
                reversedAssetIds.length > 0 ? ` (${reversedAssetIds.length})` : ""
              }`}
        </button>
        {cacheStatus ? (
          <p className="muted hook-cache-status">{cacheStatus}</p>
        ) : null}

        <div className="hook-render-list-header">
          <h3>Scratch renders</h3>
          {rendersBusy ? <span className="muted">Refreshing…</span> : null}
        </div>

        {renders.length === 0 ? (
          <p className="muted hook-render-empty">
            No renders yet. Render the timeline to verify FFmpeg output.
          </p>
        ) : (
          <ul className="hook-render-list" aria-label="Scratch renders">
            {renders.map((render) => {
              const selected = render.id === selectedRenderId;
              const previewSelected = selected && viewerMode === "player";
              const detailsSelected = selected && viewerMode === "details";
              const ready = render.status === "ready";
              const rendering = render.status === "rendering";
              const selectable = ready || rendering;
              const progressPercent = renderProgressPercent(render.progress);
              return (
                <li
                  key={render.id}
                  className={`hook-render-row is-${render.status}`}
                >
                  <button
                    type="button"
                    className={`hook-render-item${previewSelected ? " is-selected" : ""}`}
                    disabled={!selectable}
                    aria-pressed={previewSelected}
                    onClick={() => {
                      if (!selectable) return;
                      setSelectedRenderId(render.id);
                      setViewerMode("player");
                      if (rendering) setPlaying(false);
                    }}
                  >
                    <span className="hook-render-item-title">
                      {formatRenderStamp(render.createdAt)}
                    </span>
                    <span className="hook-render-item-meta muted">
                      {rendering
                        ? renderProgressLabel(render.progress)
                        : render.status === "failed"
                          ? "Render failed"
                          : `${formatClock(render.durationSec)} · ${render.clipCount} clips`}
                    </span>
                    {rendering ? (
                      <span
                        className="hook-render-progress"
                        role="progressbar"
                        aria-label="Timeline render progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(progressPercent)}
                      >
                        <span
                          className="hook-render-progress-bar"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </span>
                    ) : null}
                    {render.status === "failed" && render.error ? (
                      <span className="hook-render-error">{render.error}</span>
                    ) : null}
                  </button>
                  <div className="hook-render-actions">
                    <button
                      type="button"
                      className="btn ghost hook-render-save"
                      disabled={!ready || Boolean(exportingRenderId)}
                      onClick={() => void saveRenderToDisk(render, "video")}
                    >
                      {exportingRenderId === render.id &&
                      exportingKind === "video"
                        ? "Saving…"
                        : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost hook-render-save"
                      disabled={!ready || Boolean(exportingRenderId)}
                      title="Extract and save the render audio as MP3"
                      onClick={() => void saveRenderToDisk(render, "audio")}
                    >
                      {exportingRenderId === render.id &&
                      exportingKind === "audio"
                        ? "Saving…"
                        : "Save MP3"}
                    </button>
                    <button
                      type="button"
                      className={`btn ghost hook-render-details${
                        detailsSelected ? " is-active" : ""
                      }`}
                      disabled={!(ready || rendering)}
                      aria-pressed={detailsSelected}
                      onClick={() => {
                        setSelectedRenderId(render.id);
                        setViewerMode(detailsSelected ? "player" : "details");
                        setPlaying(false);
                      }}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      className="btn ghost hook-render-delete"
                      aria-label={`Delete render from ${formatRenderStamp(render.createdAt)}`}
                      onClick={() => {
                        void deleteRender(render);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {renderModal ? (
        <PublisherRenderModal
          state={renderModal}
          onCancel={() => setRenderModal(null)}
          onConfirm={() => {
            void runRender();
          }}
          onDismissError={() => setRenderModal(null)}
        />
      ) : null}

    </div>
  );
}
