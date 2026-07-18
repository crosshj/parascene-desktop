import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useShell } from "../../app/ShellProvider";
import { projectAspectCss } from "../../project/aspectRatios";
import {
  deleteTimelineRender,
  exportTimelineRender,
  listTimelineRenders,
  renderTimeline,
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
import { PublisherRenderDetailsModal } from "./PublisherRenderDetailsModal";

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
  if (!progress || progress.total <= 0) return 0;
  const phaseProgress = Math.min(1, Math.max(0, progress.done / progress.total));
  return progress.phase === "prepare"
    ? phaseProgress * 20
    : 20 + phaseProgress * 80;
}

function renderProgressLabel(progress: RenderProgress | null): string {
  if (!progress) return "Starting FFmpeg…";
  if (progress.phase === "prepare") return "Preparing clips…";
  return "Rendering with FFmpeg…";
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
  const [detailsRender, setDetailsRender] = useState<TimelineRender | null>(null);
  const [exportingRenderId, setExportingRenderId] = useState<string | null>(null);
  const [rebuildingCache, setRebuildingCache] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [volume, setVolume] = useState(80);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playheadRef = useRef(0);

  const hasTimeline = project.timeline.length > 0;
  const renderInProgress = renders.some((render) => render.status === "rendering");
  const selectedRender =
    renders.find((render) => render.id === selectedRenderId) ?? null;
  const activeDurationSec = selectedRender?.durationSec ?? sequenceDurationSec;
  const activeVideoSrc = renderVideoSrc(selectedRender);

  const refreshRenders = useCallback(async () => {
    try {
      const rows = await listTimelineRenders(project.id);
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
    } catch (error) {
      console.error("Failed to list timeline renders", error);
    } finally {
      setRendersBusy(false);
    }
  }, [project.id]);

  const [rendersProjectId, setRendersProjectId] = useState<string | null>(null);
  if (project.id !== rendersProjectId) {
    setRendersProjectId(project.id);
    setRendersBusy(true);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listTimelineRenders(project.id);
        if (cancelled) return;
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
      } catch (error) {
        console.error("Failed to list timeline renders", error);
      } finally {
        if (!cancelled) setRendersBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project.id]);

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
    const el = videoRef.current;
    if (el) el.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume, activeVideoSrc]);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;

    void listen<RenderProgress>("publisher-render-progress", (event) => {
      if (event.payload.projectId !== project.id) return;
      setRenders((current) =>
        current.map((render) =>
          render.id === event.payload.renderId
            ? { ...render, progress: event.payload }
            : render,
        ),
      );
    }).then((fn) => {
      unlistenProgress = fn;
    });

    void listen<RenderFinished>("publisher-render-finished", (event) => {
      if (event.payload.projectId !== project.id) return;
      void refreshRenders();
    }).then((fn) => {
      unlistenFinished = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, [project.id, refreshRenders]);

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
    }
    void el.play().catch(() => {});
    setPlaying(true);
  }, [activeDurationSec, activeVideoSrc, playheadSec, playing]);

  useEffect(() => {
    if (!activeVideoSrc || renderModal || detailsRender) return;

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
    detailsRender,
    renderModal,
    seekTo,
    togglePlay,
  ]);

  const startRender = () => {
    if (!hasTimeline || renderModal) return;
    setRenderModal({
      phase: "confirm",
      clipCount: project.timeline.length,
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
    setRenderModal({
      phase: "running",
      clipCount: project.timeline.length,
      progress: null,
    });
    try {
      const created = await renderTimeline(
        project.id,
        project.aspectRatio,
        timelineClipsToRenderInput(project.timeline),
      );
      setRenderModal(null);
      setRenders((current) => [
        created,
        ...current.filter((render) => render.id !== created.id),
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not start timeline render.";
      setRenderModal({
        phase: "error",
        clipCount: project.timeline.length,
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
      if (detailsRender?.id === render.id) setDetailsRender(null);
      if (selectedRenderId === render.id) {
        setSelectedRenderId(null);
        setPlaying(false);
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

  const saveRenderToDisk = async (render: TimelineRender) => {
    if (exportingRenderId) return;
    setExportingRenderId(render.id);
    try {
      const result = await exportTimelineRender(
        project.id,
        render.id,
        project.title,
      );
      if (result.cancelled) return;
      await confirm({
        title: "Saved",
        message: result.path
          ? `Render saved to:\n${result.path}`
          : "Render saved.",
        confirmLabel: "OK",
        hideCancel: true,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not save render.";
      await confirm({
        title: "Save failed",
        message,
        confirmLabel: "OK",
        hideCancel: true,
      });
      console.error(message);
    } finally {
      setExportingRenderId(null);
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
        <div className="hook-player">
          <div className="hook-player-frame">
            <div className="hook-player-surface" style={surfaceStyle}>
              {activeVideoSrc ? (
                <video
                  ref={videoRef}
                  className="hook-player-video"
                  src={activeVideoSrc}
                  playsInline
                  preload="auto"
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
              const ready = render.status === "ready";
              const rendering = render.status === "rendering";
              const progressPercent = renderProgressPercent(render.progress);
              return (
                <li
                  key={render.id}
                  className={`hook-render-row is-${render.status}`}
                >
                  <button
                    type="button"
                    className={`hook-render-item${selected ? " is-selected" : ""}`}
                    disabled={!ready}
                    onClick={() => {
                      if (ready) setSelectedRenderId(render.id);
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
                      onClick={() => void saveRenderToDisk(render)}
                    >
                      {exportingRenderId === render.id ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost hook-render-details"
                      disabled={!ready}
                      onClick={() => setDetailsRender(render)}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      className="btn ghost hook-render-delete"
                      disabled={rendering}
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

      {detailsRender ? (
        <PublisherRenderDetailsModal
          render={detailsRender}
          onClose={() => setDetailsRender(null)}
        />
      ) : null}
    </div>
  );
}
