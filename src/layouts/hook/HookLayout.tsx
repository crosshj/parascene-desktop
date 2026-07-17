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
  type RenderProgress,
  type TimelineRender,
} from "../../publisher/renderClient";
import { timelineSequenceDuration } from "../editor/timelineCompose";
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
  if (!render?.path) return null;
  try {
    return convertFileSrc(render.path);
  } catch {
    return null;
  }
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
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState(0);
  const [volume, setVolume] = useState(80);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playheadRef = useRef(0);

  const hasTimeline = project.timeline.length > 0;
  const selectedRender =
    renders.find((render) => render.id === selectedRenderId) ?? null;
  const activeDurationSec = selectedRender?.durationSec ?? sequenceDurationSec;
  const activeVideoSrc = renderVideoSrc(selectedRender);

  const refreshRenders = useCallback(async () => {
    try {
      const rows = await listTimelineRenders(project.id);
      setRenders(rows);
      setSelectedRenderId((current) => {
        if (current && rows.some((row) => row.id === current)) return current;
        return rows[0]?.id ?? null;
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
          if (current && rows.some((row) => row.id === current)) return current;
          return rows[0]?.id ?? null;
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
    if (!renderModal || renderModal.phase !== "running") return;
    let unlistenProgress: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;

    void listen<RenderProgress>("publisher-render-progress", (event) => {
      setRenderModal((current) =>
        current?.phase === "running"
          ? { ...current, progress: event.payload }
          : current,
      );
    }).then((fn) => {
      unlistenProgress = fn;
    });

    void listen("publisher-render-finished", () => {
      // invoke result / error handling updates modal state.
    }).then((fn) => {
      unlistenFinished = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, [renderModal?.phase]);

  const seekTo = (sec: number) => {
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
  };

  const togglePlay = () => {
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
  };

  const startRender = () => {
    if (!hasTimeline || renderModal) return;
    setRenderModal({
      phase: "confirm",
      clipCount: project.timeline.length,
    });
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
      await refreshRenders();
      setSelectedRenderId(created.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Timeline render failed.";
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

          <div className="hook-player-transport" aria-label="Playback controls">
            <button
              type="button"
              className="btn ghost hook-player-play"
              disabled={!activeVideoSrc}
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <span className="hook-player-clock">
              {formatClock(playheadSec)} / {formatClock(activeDurationSec)}
            </span>
            <input
              type="range"
              className="hook-player-scrub"
              min={0}
              max={scrubMax}
              step={0.05}
              value={Math.min(playheadSec, scrubMax)}
              disabled={!activeVideoSrc}
              aria-label="Render playhead"
              style={
                {
                  ["--scrub-progress" as string]: `${scrubProgress}%`,
                } as CSSProperties
              }
              onChange={(event) => seekTo(Number(event.target.value))}
            />
            <label className="hook-player-volume">
              <span className="visually-hidden">Volume</span>
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                disabled={!activeVideoSrc}
                aria-label="Volume"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVolume(next);
                  const el = videoRef.current;
                  if (el) el.volume = Math.max(0, Math.min(1, next / 100));
                }}
              />
            </label>
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
          disabled={!hasTimeline || Boolean(renderModal)}
          onClick={startRender}
        >
          Render timeline
        </button>

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
              return (
                <li key={render.id}>
                  <button
                    type="button"
                    className={`hook-render-item${selected ? " is-selected" : ""}`}
                    onClick={() => setSelectedRenderId(render.id)}
                  >
                    <span className="hook-render-item-title">
                      {formatRenderStamp(render.createdAt)}
                    </span>
                    <span className="hook-render-item-meta muted">
                      {formatClock(render.durationSec)} · {render.clipCount} clips
                    </span>
                  </button>
                  <div className="hook-render-actions">
                    <button
                      type="button"
                      className="btn ghost hook-render-save"
                      disabled={Boolean(exportingRenderId)}
                      onClick={() => void saveRenderToDisk(render)}
                    >
                      {exportingRenderId === render.id ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost hook-render-details"
                      onClick={() => setDetailsRender(render)}
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

      {detailsRender ? (
        <PublisherRenderDetailsModal
          render={detailsRender}
          onClose={() => setDetailsRender(null)}
        />
      ) : null}
    </div>
  );
}
