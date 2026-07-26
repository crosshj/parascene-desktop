import { useEffect, useRef, useState } from "react";
import {
  getTimelineRender,
  type RenderProgress,
  type TimelineRender,
} from "../../publisher/renderClient";

type HookRenderDetailsPaneProps = {
  projectId: string;
  render: TimelineRender;
  onClose: () => void;
};

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatSec(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}s`;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function elapsedMs(
  startedAt: string,
  finishedAt: string | null | undefined,
  nowMs: number,
): number | null {
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : nowMs;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case "prepare":
      return "Prepare sources";
    case "encode_segment":
      return "Encode segment";
    case "concat":
      return "Final concat re-encode";
    case "render":
      return "Render";
    default:
      return phase?.trim() || "—";
  }
}

function formatLookName(
  render: TimelineRender,
  progress: RenderProgress | null | undefined,
): string {
  const named =
    progress?.lookLabel?.trim() || render.lookLabel?.trim() || "";
  if (named) return named;
  if (progress?.lookEnabled === true) return "On";
  if (progress?.lookEnabled === false) return "Off";
  if (render.status !== "rendering") return "Off";
  return "—";
}

// eslint-disable-next-line react-refresh/only-export-components
export function describeRenderProgress(
  progress: RenderProgress | null | undefined,
): string {
  if (!progress) return "Starting FFmpeg…";
  if (progress.message?.trim()) return progress.message.trim();
  if (progress.phase === "prepare") {
    return progress.total > 0
      ? `Preparing sources ${progress.done}/${progress.total}…`
      : "Preparing clips…";
  }
  if (progress.phase === "encode_segment") {
    const n = progress.segmentIndex ?? progress.done;
    const total = progress.segmentCount ?? Math.max(0, progress.total - 1);
    return total > 0
      ? `Encoding segment ${n} of ${total}…`
      : "Encoding segments…";
  }
  if (progress.phase === "concat") {
    return progress.lookLabel
      ? `Final concat re-encode with ${progress.lookLabel} Look…`
      : progress.lookEnabled
        ? "Final concat re-encode with Look filters…"
        : "Final concat re-encode…";
  }
  if (progress.phase === "render") return "Rendering with FFmpeg…";
  return "Working…";
}

// eslint-disable-next-line react-refresh/only-export-components
export function renderProgressPercent(
  progress: RenderProgress | null | undefined,
): number {
  if (!progress || progress.total <= 0) return 0;
  const phaseProgress = Math.min(1, Math.max(0, progress.done / progress.total));
  if (progress.phase === "prepare") return phaseProgress * 15;
  if (progress.phase === "concat") return 85 + phaseProgress * 15;
  if (progress.phase === "encode_segment" || progress.phase === "render") {
    return 15 + phaseProgress * 70;
  }
  return phaseProgress * 100;
}

/** Full-width details pane shown in the Hook viewer (replaces the old modal). */
export function HookRenderDetailsPane({
  projectId,
  render,
  onClose,
}: HookRenderDetailsPaneProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fullCommandLine, setFullCommandLine] = useState<string | null>(null);
  const commandRef = useRef<HTMLTextAreaElement | null>(null);
  const rendering = render.status === "rendering";
  const progress = render.progress;
  const percent = renderProgressPercent(progress);
  const elapsed = elapsedMs(render.createdAt, render.finishedAt, nowMs);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!rendering) return;
    /* eslint-disable react-hooks/set-state-in-effect -- seed elapsed clock, then tick */
    setNowMs(Date.now());
    /* eslint-enable react-hooks/set-state-in-effect */
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [rendering, render.id]);

  // List payloads omit commandLine; fetch the full log only when Details opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale log on render change
    setFullCommandLine(null);
    if (rendering) return;
    let cancelled = false;
    void getTimelineRender(projectId, render.id)
      .then((full) => {
        if (!cancelled) setFullCommandLine(full.commandLine);
      })
      .catch(() => {
        if (!cancelled) setFullCommandLine(render.commandLine);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, render.id, render.commandLine, rendering]);

  const storedCommand = fullCommandLine ?? render.commandLine;
  const command =
    (rendering
      ? progress?.currentCommand?.trim() || ""
      : storedCommand.trim()) ||
    (rendering
      ? "FFmpeg command will appear when the current step starts."
      : fullCommandLine == null
        ? "Loading command log…"
        : "Command line was not recorded for this older render. Create a new render to capture it.");

  const copyEnabled = rendering
    ? Boolean(progress?.currentCommand?.trim())
    : Boolean(storedCommand.trim());

  const copyCommand = async () => {
    const text =
      (rendering ? progress?.currentCommand : storedCommand)?.trim() || "";
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = commandRef.current;
        if (!field) throw new Error("Command field unavailable");
        field.focus();
        field.select();
        if (!document.execCommand("copy")) throw new Error("Copy was rejected");
      }
      setCopyState("copied");
    } catch {
      const field = commandRef.current;
      field?.focus();
      field?.select();
      setCopyState("error");
    }
  };

  return (
    <div className="hook-render-details-pane" aria-label="Render details">
      <div className="hook-render-details-pane-header">
        <div>
          <p className="hook-render-details-pane-eyebrow muted">
            {rendering ? "Render in progress" : "Render details"}
          </p>
          <h2 className="hook-render-details-pane-title">
            {rendering
              ? describeRenderProgress(progress)
              : formatCreatedAt(render.createdAt)}
          </h2>
        </div>
        <div className="hook-render-details-pane-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={!copyEnabled}
            onClick={() => void copyCommand()}
          >
            {copyState === "copied"
              ? "Copied"
              : copyState === "error"
                ? "Copy failed"
                : "Copy command"}
          </button>
        </div>
      </div>

      {rendering ? (
        <div
          className="hook-render-details-pane-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-label="Render progress"
        >
          <span
            className="hook-render-details-pane-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}

      <dl className="hook-render-details-pane-meta">
        <div>
          <dt>Status</dt>
          <dd>{render.status}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatCreatedAt(render.createdAt)}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>
            {elapsed == null
              ? "—"
              : rendering || render.finishedAt
                ? formatElapsed(elapsed)
                : "—"}
          </dd>
        </div>
        {render.finishedAt && !rendering ? (
          <div>
            <dt>Finished</dt>
            <dd>{formatCreatedAt(render.finishedAt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Timeline</dt>
          <dd>
            {formatSec(progress?.timelineDurationSec ?? render.durationSec)}
          </dd>
        </div>
        <div>
          <dt>Aspect</dt>
          <dd>{render.aspectRatio}</dd>
        </div>
        <div>
          <dt>Clips</dt>
          <dd>{render.clipCount}</dd>
        </div>
        <div>
          <dt>Look</dt>
          <dd>{formatLookName(render, progress)}</dd>
        </div>
        <div className="hook-render-details-pane-span hook-render-details-pane-output">
          <dt>Output</dt>
          <dd>{render.path || "—"}</dd>
        </div>
        {rendering ? (
          <>
            <div>
              <dt>Phase</dt>
              <dd>{phaseLabel(progress?.phase)}</dd>
            </div>
            <div>
              <dt>Step</dt>
              <dd>
                {progress ? `${progress.done} / ${progress.total}` : "—"}
              </dd>
            </div>
            {progress?.segmentIndex != null && progress.segmentCount != null ? (
              <div>
                <dt>Segment</dt>
                <dd>
                  {progress.segmentIndex} of {progress.segmentCount}
                  {progress.segmentDurationSec != null
                    ? ` · ${formatSec(progress.segmentDurationSec)}`
                    : ""}
                </dd>
              </div>
            ) : null}
            <div className="hook-render-details-pane-span">
              <dt>Now</dt>
              <dd>{describeRenderProgress(progress)}</dd>
            </div>
          </>
        ) : null}
        {render.error ? (
          <div className="hook-render-details-pane-span">
            <dt>Error</dt>
            <dd>{render.error}</dd>
          </div>
        ) : null}
      </dl>

      <label
        className="hook-render-command-label"
        htmlFor="hook-render-command-pane"
      >
        {rendering ? "Current FFmpeg command" : "FFmpeg command"}
      </label>
      <textarea
        ref={commandRef}
        id="hook-render-command-pane"
        className="hook-render-command hook-render-command-pane"
        value={command}
        readOnly
        rows={14}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}
