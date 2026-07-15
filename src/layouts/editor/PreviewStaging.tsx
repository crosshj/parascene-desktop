import {
  useRef,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clearStagedClipDrag,
  getActiveStagedClipDrag,
  serializeStagedClip,
  setActiveStagedClipDrag,
  setStagedClipPointer,
  STAGED_CLIP_MIME,
  stagedClipDuration,
  targetLaneForDraft,
  type StagedClipDraft,
  type StagedClipFraming,
  type StagedClipTransform,
} from "./stagedClip";

type StagingFieldsProps = {
  draft: StagedClipDraft;
  sourceDurationSec: number;
  onDraftChange: (draft: StagedClipDraft) => void;
};

type ClipDragHandleProps = {
  draft: StagedClipDraft;
};

function clampInOut(
  draft: StagedClipDraft,
  patch: Partial<Pick<StagedClipDraft, "inSec" | "outSec">>,
  maxSec: number,
): StagedClipDraft {
  let inSec = patch.inSec ?? draft.inSec;
  let outSec = patch.outSec ?? draft.outSec;
  inSec = Math.max(0, inSec);
  if (maxSec > 0) {
    inSec = Math.min(inSec, maxSec);
    outSec = Math.min(outSec, maxSec);
  }
  outSec = Math.max(outSec, inSec + 0.1);
  return { ...draft, inSec, outSec };
}

function formatDurationInput(sec: number): string {
  if (!Number.isFinite(sec)) return "0";
  return (Math.round(sec * 10) / 10).toFixed(1);
}

export function StagingFields({
  draft,
  sourceDurationSec,
  onDraftChange,
}: StagingFieldsProps) {
  const duration = stagedClipDuration(draft);
  const maxSec =
    draft.kind === "image"
      ? Math.max(60, draft.outSec)
      : sourceDurationSec > 0
        ? sourceDurationSec
        : draft.outSec;

  return (
    <div className="editor-staging-controls">
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
          <label className="editor-staging-field">
            <span>Framing</span>
            <select
              value={draft.framing}
              onChange={(e) =>
                onDraftChange({
                  ...draft,
                  framing: e.target.value as StagedClipFraming,
                })
              }
            >
              <option value="fit">Fit</option>
              <option value="fill">Fill</option>
              <option value="stretch">Stretch</option>
            </select>
          </label>
        </>
      ) : null}

      {draft.kind === "video" || draft.kind === "audio" ? (
        <>
          <label className="editor-staging-field">
            <span>In</span>
            <input
              type="number"
              min={0}
              max={maxSec}
              step={0.1}
              value={formatDurationInput(draft.inSec)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next)) return;
                onDraftChange(clampInOut(draft, { inSec: next }, maxSec));
              }}
            />
            <span className="muted">sec</span>
          </label>
          <label className="editor-staging-field">
            <span>Out</span>
            <input
              type="number"
              min={draft.inSec + 0.1}
              max={maxSec}
              step={0.1}
              value={formatDurationInput(draft.outSec)}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (!Number.isFinite(next)) return;
                onDraftChange(clampInOut(draft, { outSec: next }, maxSec));
              }}
            />
            <span className="muted">sec</span>
          </label>
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
          ) : (
            <label className="editor-staging-field">
              <span>Level</span>
              <input type="range" min={0} max={100} defaultValue={80} disabled />
            </label>
          )}
        </>
      ) : null}
    </div>
  );
}

const DRAG_THRESHOLD_PX = 4;

export function ClipDragHandle({ draft }: ClipDragHandleProps) {
  const lane = targetLaneForDraft(draft);
  const laneLabel = lane === "audio" ? "A1" : "V1";
  const draggingRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerIdRef.current = event.pointerId;
    originRef.current = { x: event.clientX, y: event.clientY };
    draggingRef.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId || !originRef.current) return;
    const dx = event.clientX - originRef.current.x;
    const dy = event.clientY - originRef.current.y;
    if (!draggingRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      return;
    }
    if (!draggingRef.current) {
      draggingRef.current = true;
      setActiveStagedClipDrag(draft);
      document.body.classList.add("is-staged-clip-dragging");
    }
    setStagedClipPointer({ x: event.clientX, y: event.clientY });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const wasDragging = draggingRef.current;
    document.body.classList.remove("is-staged-clip-dragging");
    if (wasDragging) {
      const dropped = getActiveStagedClipDrag() ?? draft;
      window.dispatchEvent(
        new CustomEvent("parascene-staged-clip-drop", {
          detail: {
            draft: dropped,
            point: { x: event.clientX, y: event.clientY },
          },
        }),
      );
    }
    draggingRef.current = false;
    originRef.current = null;
    pointerIdRef.current = null;
    clearStagedClipDrag();
  };

  const onPointerCancel = () => {
    document.body.classList.remove("is-staged-clip-dragging");
    draggingRef.current = false;
    originRef.current = null;
    pointerIdRef.current = null;
    clearStagedClipDrag();
  };

  // HTML5 DnD secondary path (Chromium).
  const onDragStart = (event: DragEvent<HTMLDivElement>) => {
    const payload = serializeStagedClip(draft);
    try {
      event.dataTransfer.setData(STAGED_CLIP_MIME, payload);
      event.dataTransfer.setData("text/plain", payload);
    } catch {
      // WebKit may reject custom MIME types.
    }
    event.dataTransfer.effectAllowed = "copy";
    setActiveStagedClipDrag(draft);
    document.body.classList.add("is-staged-clip-dragging");
  };

  const onDragEnd = () => {
    document.body.classList.remove("is-staged-clip-dragging");
    clearStagedClipDrag();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="editor-cartridge-grip"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title="Drag to timeline"
      aria-label="Drag prepared clip to timeline"
    >
      <span className="editor-cartridge-grip-dots" aria-hidden />
      <span className="editor-cartridge-grip-label">Drag clip</span>
      <span className="editor-cartridge-lane">{laneLabel}</span>
    </div>
  );
}
