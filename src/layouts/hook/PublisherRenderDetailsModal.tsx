import { useEffect, useRef, useState } from "react";
import type { TimelineRender } from "../../publisher/renderClient";

type PublisherRenderDetailsModalProps = {
  render: TimelineRender;
  onClose: () => void;
};

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function PublisherRenderDetailsModal({
  render,
  onClose,
}: PublisherRenderDetailsModalProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const commandRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const command =
    render.commandLine ||
    "Command line was not recorded for this older render. Create a new render to capture it.";

  const copyCommand = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(render.commandLine);
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
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="confirm-dialog hook-render-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hook-render-details-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="hook-render-details-title">Render details</h2>

        <dl className="hook-render-details-meta">
          <div>
            <dt>Created</dt>
            <dd>{formatCreatedAt(render.createdAt)}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{render.durationSec.toFixed(3)} seconds</dd>
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
            <dt>Output</dt>
            <dd>{render.path}</dd>
          </div>
        </dl>

        <label className="hook-render-command-label" htmlFor="hook-render-command">
          FFmpeg command
        </label>
        <textarea
          ref={commandRef}
          id="hook-render-command"
          className="hook-render-command"
          value={command}
          readOnly
          rows={10}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />

        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!render.commandLine}
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
    </div>
  );
}
