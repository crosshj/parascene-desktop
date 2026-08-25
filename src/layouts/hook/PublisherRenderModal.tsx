import { useEffect } from "react";

export type PublisherRenderModalState =
  | { phase: "confirm"; clipCount: number; lookLabels: string[] }
  | { phase: "error"; clipCount: number; lookLabels: string[]; message: string };

type PublisherRenderModalProps = {
  state: PublisherRenderModalState;
  onCancel: () => void;
  onConfirm: () => void;
  onDismissError: () => void;
};

export function PublisherRenderModal({
  state,
  onCancel,
  onConfirm,
  onDismissError,
}: PublisherRenderModalProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (state.phase === "error") onDismissError();
      else onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.phase, onCancel, onDismissError]);

  const title = state.phase === "error" ? "Render failed" : "Render timeline?";
  const message =
    state.phase === "error"
      ? state.message
      : `Creates an FFmpeg render of the current timeline (${state.clipCount} clips). The file is saved to disk as a scratch preview — it is not added to the library.`;
  const lookLine =
    state.lookLabels.length > 0 ? `Look: ${state.lookLabels.join(", ")}` : null;

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={() => {
        if (state.phase === "error") onDismissError();
        else onCancel();
      }}
    >
      <div
        className="confirm-dialog timeline-merge-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="publisher-render-title"
        aria-describedby="publisher-render-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="publisher-render-title">{title}</h2>
        <p id="publisher-render-message" className="muted">
          {message}
        </p>
        {lookLine && state.phase !== "error" ? (
          <p className="muted publisher-render-look">{lookLine}</p>
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
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              onClick={onDismissError}
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
