import { useEffect, useId, useRef, useState } from "react";
import type { AddAssetGeneration } from "../../project/types";

type GeneratedClipBadgeProps = {
  generation: AddAssetGeneration;
  className?: string;
  /** Icon-only badge for narrow timeline clips. */
  compact?: boolean;
  /** Place a new generate placeholder seeded from this clip’s params. */
  onDuplicateAsNewGenerate?: () => void;
};

function formatGeneratedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function modeLabel(generation: AddAssetGeneration): string {
  if (generation.mode === "none") return "Text → video";
  if (generation.mode === "first_last") return "First + last frame";
  if (generation.mode === "motion_match") return "Motion match";
  return "Start frame";
}

function providerLabel(generation: AddAssetGeneration): string | null {
  const provider = generation.provider?.trim();
  if (provider === "parascene_blue") return "Parascene Blue";
  if (provider === "replicate") return "Replicate";
  if (provider === "parascene") return "Parascene";
  const model = generation.model?.trim();
  if (model?.includes("/")) return "Replicate";
  if (model) return "Parascene Blue";
  return null;
}

export function GeneratedClipBadge({
  generation,
  className = "",
  compact = false,
  onDuplicateAsNewGenerate,
}: GeneratedClipBadgeProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const popoverId = useId();
  const prompt = generation.prompt.trim() || "—";
  const provider = providerLabel(generation);
  const model = generation.model?.trim() || null;

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

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copyPrompt = async () => {
    const text = generation.prompt.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span
      ref={rootRef}
      className={`editor-generated-clip-badge${
        compact ? " is-compact" : ""
      }${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
    >
      <button
        type="button"
        className="editor-generated-clip-trigger"
        aria-label="Generation details"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {compact ? null : (
          <span className="editor-generated-clip-pill">Generated</span>
        )}
        <span className="editor-generated-clip-info" aria-hidden>
          ℹ
        </span>
      </button>
      {open ? (
        <div
          id={popoverId}
          className="editor-generated-clip-popover"
          role="dialog"
          aria-label="Generation details"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="editor-generated-clip-popover-header">
            <div>
              <h3 className="editor-generated-clip-popover-title">
                Generation details
              </h3>
              <p className="muted editor-generated-clip-popover-meta">
                {[provider, modeLabel(generation), model]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <button
              type="button"
              className="btn ghost editor-generated-clip-popover-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          <div className="editor-generated-clip-popover-body">
            <section className="editor-generated-clip-popover-section">
              <div className="editor-generated-clip-popover-section-head">
                <h4>Prompt</h4>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!generation.prompt.trim()}
                  onClick={() => {
                    void copyPrompt();
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="editor-generated-clip-prompt">{prompt}</pre>
            </section>

            {generation.mode === "first_last" ||
            generation.mode === "motion_match" ||
            generation.mode === "none" ? null : (
              <section className="editor-generated-clip-popover-section">
                <h4>Audio</h4>
                <p>
                  {generation.audioMode === "vocals"
                    ? "Lyrics track"
                    : generation.audioMode === "none"
                      ? "None"
                      : "Full mix"}
                </p>
              </section>
            )}

            {generation.lyricsText?.trim() ? (
              <section className="editor-generated-clip-popover-section">
                <h4>Lyrics</h4>
                <pre className="editor-generated-clip-prompt is-lyrics">
                  {generation.lyricsText.trim()}
                </pre>
              </section>
            ) : null}

            <p className="muted editor-generated-clip-popover-foot">
              {formatGeneratedAt(generation.generatedAt)}
              <br />
              Creation {generation.creationId}
            </p>
          </div>

          <footer className="editor-generated-clip-popover-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={!generation.prompt.trim()}
              onClick={() => {
                void copyPrompt();
              }}
            >
              {copied ? "Copied" : "Copy prompt"}
            </button>
            {onDuplicateAsNewGenerate ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onDuplicateAsNewGenerate();
                  setOpen(false);
                }}
              >
                Duplicate as new generate
              </button>
            ) : null}
          </footer>
        </div>
      ) : null}
    </span>
  );
}
