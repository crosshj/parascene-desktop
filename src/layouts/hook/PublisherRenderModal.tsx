import { useEffect } from "react";
import type { RenderProgress } from "../../publisher/renderClient";

export type PublisherRenderModalState =
  | { phase: "confirm"; clipCount: number }
  | { phase: "running"; clipCount: number; progress: RenderProgress | null }
  | { phase: "error"; clipCount: number; message: string };

type PublisherRenderModalProps = {
  state: PublisherRenderModalState;
  onCancel: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
};

function progressLabel(progress: RenderProgress | null): string {
  if (!progress) return "Starting render…";
  if (progress.phase === "prepare") {
    return `Preparing clips ${progress.done}/${progress.total}…`;
  }
  if (progress.phase === "render") return "Rendering with FFmpeg…";
  return "Working…";
}

export function PublisherRenderModal({
  state,
  onCancel,
  onConfirm,
  onDismissError,
}: PublisherRenderModalProps) {
  const locked = state.phase === "running";

  useEffect(() => {
    if (locked) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (state.phase === "error") onDismissError();
      else onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [locked, state.phase, onCancel, onDismissError]);

  const title =
    state.phase === "error"
      ? "Render failed"
      : locked
        ? "Rendering timeline…"
        : "Render timeline?";

  const message =
    state.phase === "error"
      ? state.message
      : locked
        ? progressLabel(state.progress)
        : `Creates an FFmpeg render of the current timeline (${state.clipCount} clips). The file is saved to disk as a scratch preview — it is not added to the library.`;

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (locked) return;
        if (state.phase === "error") onDismissError();
        else onCancel();
      }}
    >
      <div
        className="confirm-dialog timeline-merge-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-busy={locked || undefined}
        aria-labelledby="publisher-render-title"
        aria-describedby="publisher-render-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="publisher-render-title">{title}</h2>
        <p id="publisher-render-message" className="muted">
          {message}
        </p>

        {locked ? (
          <div
            className="timeline-merge-progress"
            role="progressbar"
            aria-label="Render progress"
          >
            <span className="timeline-merge-progress-bar" />
          </div>
        ) : null}

        <div className="confirm-dialog-actions">
          {state.phase === "confirm" ? (
            <>
              <button type="button" className="btn ghost" onClick={onCancel}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                autoFocus
                onClick={onConfirm}
              >
                Render with FFmpeg
              </button>
            </>
          ) : null}
          {state.phase === "running" ? (
            <button type="button" className="btn ghost" disabled>
              Working…
            </button>
          ) : null}
          {state.phase === "error" ? (
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              onClick={onDismissError}
            >
              Close
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
