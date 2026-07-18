import { useEffect, useRef, type CSSProperties } from "react";
import {
  clearStagedClipDrag,
  getActiveStagedClipDrag,
  newSlideshowSeed,
  remapTrimForReverse,
  setActiveStagedClipDrag,
  setStagedClipPointer,
  stagedClipDuration,
  targetLaneForDraft,
  type SlideshowMode,
  type StagedClipDraft,
  type StagedClipFraming,
  type StagedClipTransform,
} from "./stagedClip";
import type { BakeInfo } from "../../library/slideshowMedia";
import {
  DEFAULT_SLIDESHOW_SENSITIVITY,
  isBeatSlideshowMode,
} from "../../project/types";

/** Per-mode label + endpoint hints for the sensitivity dial. */
const SENSITIVITY_LABELS: Record<
  string,
  { label: string; low: string; high: string; title: string }
> = {
  beat_classic: {
    label: "Sensitivity",
    low: "Sparse",
    high: "Busy",
    title: "Onset threshold — how easily subtle hits become cuts",
  },
  beat_grid: {
    label: "Looseness",
    low: "Strict",
    high: "Organic",
    title: "Snap looseness — how far beats slide to hug real onsets",
  },
  beat_drums: {
    label: "Fills",
    low: "Rare",
    high: "Eager",
    title: "Fill threshold — how readily fast passages subdivide",
  },
  beat_energy: {
    label: "Match",
    low: "Subtle",
    high: "Dramatic",
    title: "Loudness match strength between image energy and the music",
  },
};

type StagingFieldsProps = {
  draft: StagedClipDraft;
  sourceDurationSec: number;
  onDraftChange: (draft: StagedClipDraft) => void;
  /** Runtime slideshow bake status when editing a timeline clip. */
  bakeInfo?: BakeInfo | null;
};

type ClipDragHandleProps = {
  draft: StagedClipDraft;
};

type SlideshowRenderHandleProps = {
  onRender: () => void;
  rendering?: boolean;
};

function formatDurationInput(sec: number): string {
  if (!Number.isFinite(sec)) return "0";
  return (Math.round(sec * 10) / 10).toFixed(1);
}

export function StagingFields({
  draft,
  sourceDurationSec,
  onDraftChange,
  bakeInfo = null,
}: StagingFieldsProps) {
  const duration = stagedClipDuration(draft);
  const maxSec =
    draft.kind === "image" || draft.kind === "slideshow"
      ? Math.max(60, draft.outSec)
      : sourceDurationSec > 0
        ? sourceDurationSec
        : draft.outSec;
  const slideshowMode: SlideshowMode = draft.slideshow?.mode ?? "even";
  const slideshowRandom = draft.slideshow?.random === true;

  return (
    <div className="editor-staging-controls">
      {draft.kind === "slideshow" ? (
        <>
          <label className="editor-staging-field">
            <span>Duration</span>
            <input
              type="number"
              min={0.5}
              max={120}
              step={0.5}
              value={formatDurationInput(duration)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next) || next <= 0) return;
                onDraftChange({
                  ...draft,
                  inSec: 0,
                  outSec: next,
                  bakeKey: null,
                  bakePath: null,
                });
              }}
            />
            <span className="muted">sec</span>
          </label>
          <label className="editor-staging-field">
            <span>Mode</span>
            <select
              value={slideshowMode}
              onChange={(e) => {
                const mode = e.target.value as SlideshowMode;
                if (!draft.slideshow) return;
                onDraftChange({
                  ...draft,
                  slideshow: {
                    ...draft.slideshow,
                    mode,
                    // Clear beat audio binding when switching modes; drop rebinds.
                    audioAssetId: undefined,
                    audioInSec: undefined,
                    audioOutSec: undefined,
                    audioStartSec: undefined,
                    audioEndSec: undefined,
                  },
                  bakeKey: null,
                  bakePath: null,
                });
              }}
            >
              <option value="even">🎞️ Storyboard Drift</option>
              <option value="beat_classic">✨ Spark Cut — Original</option>
              <option value="beat_grid">💜 Pulse Grid — Tempo locked</option>
              <option value="beat_drums">🔥 Drumfire — Fast fills</option>
              <option value="beat_energy">🌈 Color Current — Energy matched</option>
            </select>
          </label>
          <label className="editor-staging-field editor-staging-field-check">
            <span>Random</span>
            <input
              type="checkbox"
              checked={slideshowRandom}
              onChange={(e) => {
                if (!draft.slideshow) return;
                const random = e.target.checked;
                onDraftChange({
                  ...draft,
                  slideshow: {
                    ...draft.slideshow,
                    random: random || undefined,
                    seed: random ? newSlideshowSeed() : undefined,
                  },
                  bakeKey: null,
                  bakePath: null,
                });
              }}
            />
          </label>
          {isBeatSlideshowMode(slideshowMode) ? (
            <label
              className="editor-staging-field editor-staging-field-slider"
              title={SENSITIVITY_LABELS[slideshowMode]?.title}
            >
              <span>{SENSITIVITY_LABELS[slideshowMode]?.label ?? "Sensitivity"}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={
                  draft.slideshow?.sensitivity ?? DEFAULT_SLIDESHOW_SENSITIVITY
                }
                style={
                  {
                    ["--scrub-progress" as string]: `${
                      (draft.slideshow?.sensitivity ??
                        DEFAULT_SLIDESHOW_SENSITIVITY) * 100
                    }%`,
                  } as CSSProperties
                }
                onChange={(e) => {
                  if (!draft.slideshow) return;
                  const sensitivity = Number(e.target.value);
                  onDraftChange({
                    ...draft,
                    slideshow: {
                      ...draft.slideshow,
                      sensitivity: Number.isFinite(sensitivity)
                        ? sensitivity
                        : undefined,
                    },
                    bakeKey: null,
                    bakePath: null,
                  });
                }}
              />
              <span className="muted editor-staging-slider-hint">
                {SENSITIVITY_LABELS[slideshowMode]?.low}
                {" · "}
                {SENSITIVITY_LABELS[slideshowMode]?.high}
              </span>
            </label>
          ) : null}
          {bakeInfo?.status === "failed" ? (
            <p className="editor-staging-error" role="alert">
              {bakeInfo.error?.trim() || "Slideshow render failed"}
            </p>
          ) : null}
        </>
      ) : null}

      {draft.kind === "image" ? (
        <>
          <label className="editor-staging-field">
            <span>Duration</span>
            <input
              type="number"
              min={0.5}
              max={120}
              step={0.5}
              value={formatDurationInput(duration)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next) || next <= 0) return;
                onDraftChange({
                  ...draft,
                  inSec: 0,
                  outSec: next,
                });
              }}
            />
            <span className="muted">sec</span>
          </label>
          <label className="editor-staging-field">
            <span>Motion</span>
            <select
              value={draft.transform}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  transform: e.target.value as StagedClipTransform,
                })
              }
            >
              <option value="hold">Hold</option>
              <option value="kenBurns">Ken Burns</option>
            </select>
          </label>
        </>
      ) : null}

      {draft.kind === "image" ||
      draft.kind === "video" ||
      draft.kind === "slideshow" ? (
        <label className="editor-staging-field">
          <span>Framing</span>
          <select
            value={draft.framing}
            onChange={(e) =>
              onDraftChange({
                ...draft,
                framing: e.target.value as StagedClipFraming,
                ...(draft.kind === "slideshow"
                  ? { bakeKey: null, bakePath: null }
                  : {}),
              })
            }
          >
            <option value="fit">Fit</option>
            <option value="fill">Fill</option>
            <option value="stretch">Stretch</option>
          </select>
        </label>
      ) : null}

      {draft.kind === "video" || draft.kind === "audio" ? (
        <>
          {draft.kind === "video" ? (
            <label className="editor-staging-field editor-staging-field-check">
              <span>Audio</span>
              <input
                type="checkbox"
                checked={draft.includeAudio}
                onChange={(e) =>
                  onDraftChange({
                    ...draft,
                    includeAudio: e.target.checked,
                  })
                }
              />
              <span className="muted">Include</span>
            </label>
          ) : null}
          <label className="editor-staging-field editor-staging-field-check">
            <span>Reverse</span>
            <input
              type="checkbox"
              checked={draft.reverse}
              onChange={(e) => {
                const reverse = e.target.checked;
                const trim = remapTrimForReverse(draft, maxSec);
                onDraftChange({
                  ...draft,
                  ...trim,
                  reverse,
                });
              }}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}

/** Far-right deck action — same shell as ClipDragHandle, for timeline slideshows. */
export function SlideshowRenderHandle({
  onRender,
  rendering = false,
}: SlideshowRenderHandleProps) {
  return (
    <button
      type="button"
      className="editor-cartridge-grip is-action"
      disabled={rendering}
      onClick={onRender}
      title={rendering ? "Rendering slideshow…" : "Render slideshow"}
      aria-label={rendering ? "Rendering slideshow" : "Render slideshow"}
    >
      <span className="editor-cartridge-grip-label">
        {rendering ? "Rendering…" : "Render"}
      </span>
    </button>
  );
}

const DRAG_THRESHOLD_PX = 4;

export function ClipDragHandle({ draft }: ClipDragHandleProps) {
  const lane = targetLaneForDraft(draft);
  const laneLabel = lane === "audio" ? "A1" : "V1";
  const draggingRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const endDrag = (clientX: number, clientY: number, drop: boolean) => {
    const wasDragging = draggingRef.current;
    document.body.classList.remove("is-staged-clip-dragging");
    if (drop && wasDragging) {
      const dropped = getActiveStagedClipDrag() ?? draftRef.current;
      window.dispatchEvent(
        new CustomEvent("parascene-staged-clip-drop", {
          detail: {
            draft: dropped,
            point: { x: clientX, y: clientY },
          },
        }),
      );
    }
    draggingRef.current = false;
    originRef.current = null;
    pointerIdRef.current = null;
    clearStagedClipDrag();
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Prevent native HTML5 drag / text selection from stealing the gesture.
    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    pointerIdRef.current = pointerId;
    originRef.current = { x: event.clientX, y: event.clientY };
    draggingRef.current = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !originRef.current) return;
      const dx = ev.clientX - originRef.current.x;
      const dy = ev.clientY - originRef.current.y;
      if (!draggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
        return;
      }
      if (!draggingRef.current) {
        draggingRef.current = true;
        setActiveStagedClipDrag(draftRef.current);
        document.body.classList.add("is-staged-clip-dragging");
      }
      setStagedClipPointer({ x: ev.clientX, y: ev.clientY });
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endDrag(ev.clientX, ev.clientY, true);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="editor-cartridge-grip"
      onPointerDown={onPointerDown}
      title="Drag to timeline"
      aria-label="Drag prepared clip to timeline"
    >
      <span className="editor-cartridge-grip-dots" aria-hidden />
      <span className="editor-cartridge-grip-label">Drag clip</span>
      <span className="editor-cartridge-lane">{laneLabel}</span>
    </div>
  );
}
