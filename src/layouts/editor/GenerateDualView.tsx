import type { ReactNode } from "react";
import type { GenerateDualViewId } from "./generateDualView";

type GenerateDualViewProps = {
  view: GenerateDualViewId;
  onViewChange: (view: GenerateDualViewId) => void;
  /** Optional status line under the toggle (phase hint). */
  statusNote?: string | null;
  children: ReactNode;
};

/** Thin Result | Form chrome for generate-capable preview hosts. */
export function GenerateDualView({
  view,
  onViewChange,
  statusNote = null,
  children,
}: GenerateDualViewProps) {
  return (
    <div className="generate-dual-view" data-view={view}>
      <div className="generate-dual-view-chrome">
        <div
          className="add-asset-generate-audio-toggle generate-dual-view-toggle"
          role="group"
          aria-label="Preview view"
        >
          <button
            type="button"
            className={view === "result" ? "is-active" : ""}
            aria-pressed={view === "result"}
            onClick={() => onViewChange("result")}
          >
            Result
          </button>
          <button
            type="button"
            className={view === "form" ? "is-active" : ""}
            aria-pressed={view === "form"}
            onClick={() => onViewChange("form")}
          >
            Form
          </button>
        </div>
        {statusNote ? (
          <p className="muted generate-dual-view-status">{statusNote}</p>
        ) : null}
      </div>
      <div className="generate-dual-view-body">{children}</div>
    </div>
  );
}
