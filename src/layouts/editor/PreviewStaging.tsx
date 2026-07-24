import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import {
  clearStagedClipDrag,
  getActiveStagedClipDrag,
  newSlideshowSeed,
  remapTrimForReverse,
  setActiveStagedClipDrag,
  setStagedClipPointer,
  stagedClipDuration,
  stagedClipSourceSpan,
  stagedClipTimelineDuration,
  stagedClipTimelineExtended,
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
  type AddAssetGeneration,
} from "../../project/types";
import { GeneratedClipBadge } from "./GeneratedClipBadge";
import { subscribeGestureAbort } from "./gestureCleanup";
import { registerGestureStatusProvider } from "../../app/uiDiagnostics";

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
  /** Persisted add-asset generation metadata on the selected timeline clip. */
  addAssetGeneration?: AddAssetGeneration | null;
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
  addAssetGeneration = null,
}: StagingFieldsProps) {
  const sourceSpan = stagedClipSourceSpan(draft);
  const duration =
    draft.kind === "video"
      ? stagedClipTimelineDuration(draft)
      : stagedClipDuration(draft);
  /** Upper bound for the Duration number field (timeline placement). */
  const durationMaxSec =
    draft.kind === "image" || draft.kind === "slideshow"
      ? Math.max(60, draft.outSec)
      : draft.kind === "video"
        ? 120
        : sourceDurationSec > 0
          ? sourceDurationSec
          : draft.outSec;
  /** Source media length — required for reverse In/Out remapping. */
  const sourceMaxSec =
    sourceDurationSec > 0
      ? sourceDurationSec
      : Math.max(draft.outSec, draft.inSec + 0.1);
  const syncLocked = draft.kind === "video" && draft.timelineLocked === true;
  const slideshowMode: SlideshowMode = draft.slideshow?.mode ?? "even";
  const slideshowRandom = draft.slideshow?.random === true;

  return (
    <div className="editor-staging-controls">
      {addAssetGeneration ? (
        <div className="editor-staging-generated">
          <GeneratedClipBadge generation={addAssetGeneration} />
        </div>
      ) : null}
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

      {draft.kind === "video" ? (
        <>
          <label className="editor-staging-field">
            <span>Duration</span>
            <input
              type="number"
              min={sourceSpan}
              max={durationMaxSec}
              step={0.5}
              value={formatDurationInput(duration)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next) || next <= 0) return;
                const nextDur = Math.max(sourceSpan, next);
                const enteringExtend =
                  !stagedClipTimelineExtended(draft) &&
                  nextDur > sourceSpan + 0.001;
                onDraftChange({
                  ...draft,
                  timelineDurationSec: nextDur,
                  ...(enteringExtend ? { extendPingPong: true } : {}),
                });
              }}
            />
            <span className="muted">sec</span>
          </label>
          {stagedClipTimelineExtended(draft) ? (
            <label className="editor-staging-field editor-staging-field-check">
              <span>Ping-pong</span>
              <input
                type="checkbox"
                checked={draft.extendPingPong === true}
                onChange={(e) =>
                  onDraftChange({
                    ...draft,
                    extendPingPong: e.target.checked ? true : false,
                  })
                }
              />
            </label>
          ) : null}
        </>
      ) : null}

      {draft.kind === "video" && bakeInfo?.status === "failed" ? (
        <p className="editor-staging-error" role="alert">
          {bakeInfo.error?.trim() || "Extend bake failed"}
        </p>
      ) : null}

      {draft.kind === "video" || draft.kind === "audio" ? (
        <>
          {draft.kind === "video" ? (
            <label className="editor-staging-field editor-staging-field-check">
              <span>Sync to timeline</span>
              <input
                type="checkbox"
                checked={draft.timelineLocked === true}
                onChange={(e) =>
                  onDraftChange({
                    ...draft,
                    timelineLocked: e.target.checked ? true : undefined,
                  })
                }
              />
            </label>
          ) : null}
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
          <label
            className={`editor-staging-field editor-staging-field-check${
              syncLocked ? " is-frozen" : ""
            }`}
            title={
              syncLocked
                ? "Reverse is frozen while Sync to timeline is on — turn Sync off to change it"
                : undefined
            }
          >
            <span>Reverse</span>
            <input
              type="checkbox"
              checked={draft.reverse}
              aria-disabled={syncLocked || undefined}
              onClick={(e) => {
                // Avoid native disabled styling (browsers wash out checked).
                if (syncLocked) e.preventDefault();
              }}
              onChange={(e) => {
                if (syncLocked) return;
                const reverse = e.target.checked;
                const trim = remapTrimForReverse(draft, sourceMaxSec);
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

type ExtendBakeHandleProps = {
  onBake: () => void;
  baking?: boolean;
  label?: string;
  bakingLabel?: string;
  title?: string;
};

/** Far-right deck action — same shell as ClipDragHandle, for bake jobs. */
export function ExtendBakeHandle({
  onBake,
  baking = false,
  label = "Bake",
  bakingLabel = "Baking…",
  title,
}: ExtendBakeHandleProps) {
  return (
    <button
      type="button"
      className="editor-cartridge-grip is-action"
      disabled={baking}
      onClick={onBake}
      title={
        title ??
        (baking ? "Baking…" : "Bake")
      }
      aria-label={baking ? bakingLabel : label}
    >
      <span className="editor-cartridge-grip-label">
        {baking ? bakingLabel : label}
      </span>
    </button>
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
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const endDrag = useCallback((clientX: number, clientY: number, drop: boolean) => {
    const cleanup = gestureCleanupRef.current;
    gestureCleanupRef.current = null;
    cleanup?.();

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
  }, []);

  const abortDrag = useCallback(() => {
    if (!originRef.current && !draggingRef.current) return;
    endDrag(lastPointerRef.current.x, lastPointerRef.current.y, false);
  }, [endDrag]);

  useEffect(() => subscribeGestureAbort(abortDrag), [abortDrag]);
  useEffect(() => () => abortDrag(), [abortDrag]);

  useEffect(
    () =>
      registerGestureStatusProvider("stagedClipHandle", () => ({
        pressing: originRef.current != null,
        dragging: draggingRef.current,
        pointerId: pointerIdRef.current,
      })),
    [],
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Prevent native HTML5 drag / text selection from stealing the gesture.
    event.preventDefault();
    event.stopPropagation();

    const pointerId = event.pointerId;
    pointerIdRef.current = pointerId;
    originRef.current = { x: event.clientX, y: event.clientY };
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    draggingRef.current = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !originRef.current) return;
      lastPointerRef.current = { x: ev.clientX, y: ev.clientY };
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

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      endDrag(ev.clientX, ev.clientY, true);
    };

    gestureCleanupRef.current = cleanup;
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
