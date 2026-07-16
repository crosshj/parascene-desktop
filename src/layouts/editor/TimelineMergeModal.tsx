import { useEffect } from "react";
import type { MergeProgress } from "../../library/catalogClient";

export type TimelineMergeModalState =
  | { phase: "confirm"; clipCount: number }
  | { phase: "running"; clipCount: number; progress: MergeProgress | null }
  | { phase: "error"; clipCount: number; message: string };

type TimelineMergeModalProps = {
  state: TimelineMergeModalState;
  onCancel: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
};

function progressLabel(progress: MergeProgress | null): string {
  if (!progress) return "Starting merge…";
  if (progress.phase === "prepare") {
    return `Preparing clips ${progress.done}/${progress.total}…`;
  }
  if (progress.phase === "merge") return "Merging with FFmpeg…";
  if (progress.phase === "catalog") return "Saving to library…";
  return "Working…";
}

export function TimelineMergeModal({
  state,
  onCancel,
  onConfirm,
  onDismissError,
}: TimelineMergeModalProps) {
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
      ? "Merge failed"
      : locked
        ? "Merging clips…"
        : `Merge ${state.clipCount} clips?`;

  const message =
    state.phase === "error"
      ? state.message
      : locked
        ? progressLabel(state.progress)
        : "Creates one silent video using the FFmpeg backend, adds it to the library and project, and replaces the selected clips on the timeline.";

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
        aria-labelledby="timeline-merge-title"
        aria-describedby="timeline-merge-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="timeline-merge-title">{title}</h2>
        <p id="timeline-merge-message" className="muted">
          {message}
        </p>

        {locked ? (
          <div
            className="timeline-merge-progress"
            role="progressbar"
            aria-label="Merge progress"
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
                Merge with FFmpeg
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
