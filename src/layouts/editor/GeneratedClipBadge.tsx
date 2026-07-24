import { useEffect, useId, useRef, useState } from "react";
import type { AddAssetGeneration } from "../../project/types";

type GeneratedClipBadgeProps = {
  generation: AddAssetGeneration;
  className?: string;
  /** Icon-only badge for narrow timeline clips. */
  compact?: boolean;
};

function formatGeneratedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function GeneratedClipBadge({
  generation,
  className = "",
  compact = false,
}: GeneratedClipBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`editor-generated-clip-badge${
        compact ? " is-compact" : ""
      }${className ? ` ${className}` : ""}`}
    >
      {compact ? null : (
        <span className="editor-generated-clip-pill">Generated</span>
      )}
      <button
        type="button"
        className="editor-generated-clip-info"
        aria-label="Generation details"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        ℹ
      </button>
      {open ? (
        <div
          id={popoverId}
          className="editor-generated-clip-popover"
          role="dialog"
          aria-label="Generation details"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p>
            <strong>Prompt</strong>
            <br />
            {generation.prompt.trim() || "—"}
          </p>
          <p>
            <strong>Audio</strong>
            <br />
            {generation.audioMode === "vocals" ? "Lyrics track" : "Full mix"}
          </p>
          {generation.lyricsText?.trim() ? (
            <p>
              <strong>Lyrics</strong>
              <br />
              {generation.lyricsText.trim()}
            </p>
          ) : null}
          <p className="muted">
            {formatGeneratedAt(generation.generatedAt)}
            <br />
            Creation {generation.creationId}
          </p>
        </div>
      ) : null}
    </span>
  );
}
