import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { bakeErrorPresentation } from "./bakeErrorPresentation";

export function BakeErrorModal({
  title = "Bake failed",
  error,
  onClose,
}: {
  title?: string;
  error: string;
  onClose: () => void;
}) {
  const presentation = bakeErrorPresentation(error);
  const summary = presentation?.summary ?? "Something went wrong while baking.";
  const details = presentation?.details ?? error.trim();
  const showLog = details.length > 0 && details !== summary;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="confirm-dialog bake-error-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="bake-error-dialog-title"
        aria-describedby="bake-error-dialog-summary"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="bake-error-dialog-title">{title}</h2>
        <p id="bake-error-dialog-summary" className="muted">
          {summary}
        </p>
        {showLog ? (
          <pre className="bake-error-dialog-log">{details}</pre>
        ) : null}
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            autoFocus
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function BakeErrorButton({
  error,
  fallback,
  title = "Bake failed",
}: {
  error?: string | null;
  fallback: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const message = error?.trim() || fallback;
  return (
    <>
      <button
        type="button"
        className="editor-staging-error-btn"
        aria-label={`${title}. Show details.`}
        title={title}
        onClick={() => setOpen(true)}
      >
        !
      </button>
      {open
        ? createPortal(
            <BakeErrorModal
              title={title}
              error={message}
              onClose={() => setOpen(false)}
            />,
            document.body,
          )
        : null}
    </>
  );
}
