import { useCallback, useEffect, useState } from "react";
import {
  collectUiDiagnostics,
  formatUiDiagnosticsReport,
  unlockUi,
  type UiDiagnosticsReport,
} from "./uiDiagnostics";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function UiDiagnosticsModal({ open, onClose }: Props) {
  const [report, setReport] = useState<UiDiagnosticsReport | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [unlockNote, setUnlockNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setReport(collectUiDiagnostics());
    setCopyState("idle");
    setUnlockNote(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    // Snapshot on open; Refresh button also calls refresh().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [open, refresh]);

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

  if (!open) return null;

  const text = report ? formatUiDiagnosticsReport(report) : "Collecting…";

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const runUnlock = () => {
    const result = unlockUi();
    const note =
      result.releasedCaptures > 0
        ? `Released pointer capture on ${result.releasedCaptures} element(s) and cleared editor drag state.`
        : "Cleared editor drag state. No active pointer capture was tracked.";
    setUnlockNote(note);
    refresh();
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
        className="confirm-dialog ui-diagnostics-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ui-diagnostics-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="ui-diagnostics-title">UI diagnostics</h2>
        <p className="muted ui-diagnostics-lead">
          Snapshot of pointer capture, drag state, and what is on top of the
          screen. Use this when clicks or panel resize stop working.
        </p>
        {report ? (
          <ul className="ui-diagnostics-notes">
            {report.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {unlockNote ? <p className="ui-diagnostics-unlock-note">{unlockNote}</p> : null}
        <pre className="ui-diagnostics-report" aria-label="Diagnostics report">
          {text}
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
          <button type="button" className="btn btn-primary" onClick={runUnlock}>
            Unlock UI
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
