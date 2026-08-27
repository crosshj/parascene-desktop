import { useCallback, useEffect, useState } from "react";
import {
  formatPreviewHealthReport,
  getPreviewDiagEvents,
} from "../../playback/previewDiagnostics";
import type { PreviewPlaybackStatus } from "../../playback/timelinePlaybackEngine";

type Props = {
  open: boolean;
  onClose: () => void;
  previewStatus?: PreviewPlaybackStatus;
  fragmentStatus?: {
    ready: number;
    total: number;
    baking: boolean;
    queued?: number;
    error: string | null;
    playheadReady: boolean;
    depwait?: boolean;
  };
  onRetryPreview?: () => void;
};

function phaseHeadline(
  previewStatus?: PreviewPlaybackStatus,
  fragmentStatus?: Props["fragmentStatus"],
): string {
  if (fragmentStatus?.error) return "Preview error";
  if (previewStatus?.phase === "blocked") return "Preview blocked";
  if (previewStatus?.phase === "depwait" || fragmentStatus?.depwait) {
    return "Waiting for source media";
  }
  if (previewStatus?.phase === "loading") return "Loading preview";
  if (previewStatus?.phase === "baking" || fragmentStatus?.baking) {
    return "Baking preview";
  }
  return "Preview ready";
}

function phaseDetail(
  previewStatus?: PreviewPlaybackStatus,
  fragmentStatus?: Props["fragmentStatus"],
): string {
  if (fragmentStatus?.error) return fragmentStatus.error;
  if (previewStatus?.phase === "depwait" || fragmentStatus?.depwait) {
    return (
      previewStatus?.message ??
      "Preview is holding the last frame until source media is available locally."
    );
  }
  if (previewStatus?.message) return previewStatus.message;
  if (fragmentStatus?.baking) {
    return `Baking preview fragments… ${fragmentStatus.ready}/${fragmentStatus.total}${
      fragmentStatus.queued ? ` (${fragmentStatus.queued} queued)` : ""
    }`;
  }
  if (fragmentStatus && fragmentStatus.total > 0) {
    return `Preview cache ${fragmentStatus.ready}/${fragmentStatus.total} fragments ready.`;
  }
  return "Preview pipeline is idle. No active warnings or errors.";
}

export function PreviewHealthModal({
  open,
  onClose,
  previewStatus,
  fragmentStatus,
  onRetryPreview,
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [reportTick, setReportTick] = useState(0);

  const refresh = useCallback(() => {
    setReportTick((n) => n + 1);
    setCopyState("idle");
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const headline = phaseHeadline(previewStatus, fragmentStatus);
  const detail = phaseDetail(previewStatus, fragmentStatus);
  const canRetryPreview =
    previewStatus?.phase === "blocked"
      ? previewStatus.retryable !== false
      : previewStatus?.holding === true &&
        previewStatus?.phase === "loading" &&
        fragmentStatus?.playheadReady === true &&
        fragmentStatus?.baking !== true;

  if (!open) return null;
  void reportTick;
  const report = formatPreviewHealthReport({
    previewStatus,
    fragmentStatus,
  });
  const recentEvents = getPreviewDiagEvents().slice(-8).reverse();

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-dialog ui-diagnostics-dialog preview-health-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-health-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="preview-health-title">{headline}</h2>
        <p className="preview-health-detail">{detail}</p>
        <dl className="preview-health-summary">
          {previewStatus ? (
            <>
              <div>
                <dt>State</dt>
                <dd>{previewStatus.phase}</dd>
              </div>
              <div>
                <dt>Playhead held</dt>
                <dd>{previewStatus.holding ? "Yes" : "No"}</dd>
              </div>
            </>
          ) : null}
          {fragmentStatus ? (
            <>
              <div>
                <dt>Cache</dt>
                <dd>
                  {fragmentStatus.ready}/{fragmentStatus.total}
                  {fragmentStatus.queued
                    ? ` (${fragmentStatus.queued} queued)`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Disk ready at playhead</dt>
                <dd>{fragmentStatus.playheadReady ? "Yes" : "No"}</dd>
              </div>
            </>
          ) : null}
        </dl>
        {recentEvents.length > 0 ? (
          <ul className="preview-health-events" aria-label="Recent preview events">
            {recentEvents.map((event) => (
              <li key={`${event.ts}-${event.phase}-${event.detail ?? ""}`}>
                <span className="preview-health-event-phase">{event.phase}</span>
                {event.detail ? (
                  <span className="preview-health-event-detail">{event.detail}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <pre className="ui-diagnostics-report" aria-label="Preview diagnostics report">
          {report}
        </pre>
        <div className="confirm-dialog-actions ui-diagnostics-actions">
          <button type="button" className="btn" onClick={refresh}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={() => void copyReport()}>
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy report"}
          </button>
          {canRetryPreview ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onRetryPreview?.();
                refresh();
              }}
            >
              Retry preview
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
