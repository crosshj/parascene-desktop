import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type PreviewScrubberProps = {
  /** Current playhead time (seconds). */
  currentSec: number;
  /** Full media duration (seconds). */
  durationSec: number;
  /** Seek the playhead. */
  onSeek: (sec: number) => void;
  /** Disable seeking (no playable media). */
  disabled?: boolean;
  /**
   * When set, show draggable In/Out handles and highlight the trim range.
   * Only used for modes that offer In/Out (video / audio).
   */
  trim?: {
    inSec: number;
    outSec: number;
    onChange: (next: { inSec: number; outSec: number }) => void;
  } | null;
};

const MIN_TRIM_SEC = 0.1;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function secFromClientX(
  clientX: number,
  el: HTMLElement,
  durationSec: number,
): number {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || durationSec <= 0) return 0;
  const t = (clientX - rect.left) / rect.width;
  return clamp(t, 0, 1) * durationSec;
}

/** Build a short list of major/minor tick fractions across the duration. */
function tickMarks(durationSec: number): Array<{ t: number; major: boolean }> {
  if (!(durationSec > 0)) return [];
  // Aim for ~8–12 major ticks.
  const rough = durationSec / 10;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let majorStep = steps[steps.length - 1];
  for (const s of steps) {
    if (s >= rough) {
      majorStep = s;
      break;
    }
  }
  const minorStep = majorStep / 2;
  const out: Array<{ t: number; major: boolean }> = [];
  for (let t = 0; t <= durationSec + 1e-6; t += minorStep) {
    const clamped = Math.min(t, durationSec);
    const isMajor = Math.abs(clamped / majorStep - Math.round(clamped / majorStep)) < 1e-6;
    out.push({ t: clamped, major: isMajor || clamped === 0 || clamped === durationSec });
  }
  return out;
}

/**
 * Premiere-style preview scrubber: ruler ticks, track, playhead, and optional
 * hollow In/Out handles for trim modes.
 */
export function PreviewScrubber({
  currentSec,
  durationSec,
  onSeek,
  disabled = false,
  trim = null,
}: PreviewScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<"playhead" | "in" | "out" | null>(null);
  const liveTrimRef = useRef<{ inSec: number; outSec: number } | null>(
    trim ? { inSec: trim.inSec, outSec: trim.outSec } : null,
  );
  const onChangeRef = useRef(trim?.onChange);
  const [dragging, setDragging] = useState<"playhead" | "in" | "out" | null>(
    null,
  );
  useEffect(() => {
    onChangeRef.current = trim?.onChange;
    if (!dragging) {
      liveTrimRef.current = trim
        ? { inSec: trim.inSec, outSec: trim.outSec }
        : null;
    }
  }, [trim, dragging]);

  const duration = Math.max(durationSec, 0.1);
  const playheadPct = clamp((currentSec / duration) * 100, 0, 100);
  const inPct = trim ? clamp((trim.inSec / duration) * 100, 0, 100) : 0;
  const outPct = trim ? clamp((trim.outSec / duration) * 100, 0, 100) : 100;
  const ticks = tickMarks(duration);

  const applyDrag = useCallback(
    (clientX: number, kind: "playhead" | "in" | "out") => {
      const el = trackRef.current;
      if (!el) return;
      const sec = secFromClientX(clientX, el, duration);
      if (kind === "playhead") {
        onSeek(sec);
        return;
      }
      const live = liveTrimRef.current;
      const onChange = onChangeRef.current;
      if (!live || !onChange) return;
      if (kind === "in") {
        const inSec = clamp(sec, 0, live.outSec - MIN_TRIM_SEC);
        live.inSec = inSec;
        onChange({ inSec, outSec: live.outSec });
        onSeek(inSec);
        return;
      }
      const outSec = clamp(sec, live.inSec + MIN_TRIM_SEC, duration);
      live.outSec = outSec;
      onChange({ inSec: live.inSec, outSec });
      onSeek(outSec);
    },
    [duration, onSeek],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => {
      applyDrag(event.clientX, dragging);
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, applyDrag]);

  const beginDrag = (
    kind: "playhead" | "in" | "out",
    event: ReactPointerEvent,
  ) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = kind;
    setDragging(kind);
    applyDrag(event.clientX, kind);
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    // Don't steal handle presses (they stopPropagation); track click seeks.
    beginDrag("playhead", event);
  };

  return (
    <div
      className={`editor-preview-scrubber${disabled ? " is-disabled" : ""}${
        trim ? " has-trim" : ""
      }${dragging ? ` is-dragging-${dragging}` : ""}`}
      role="group"
      aria-label="Preview scrubber"
    >
      <div className="editor-preview-scrubber-ruler" aria-hidden>
        {ticks.map((tick, i) => (
          <span
            key={`${tick.t}-${i}`}
            className={
              tick.major
                ? "editor-preview-scrubber-tick is-major"
                : "editor-preview-scrubber-tick"
            }
            style={{ left: `${(tick.t / duration) * 100}%` }}
          />
        ))}
      </div>

      <div
        ref={trackRef}
        className="editor-preview-scrubber-track"
        onPointerDown={onTrackPointerDown}
      >
        {trim ? (
          <>
            <div
              className="editor-preview-scrubber-shade is-before"
              style={{ width: `${inPct}%` }}
            />
            <div
              className="editor-preview-scrubber-range"
              style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
            />
            <div
              className="editor-preview-scrubber-shade is-after"
              style={{ left: `${outPct}%`, width: `${Math.max(0, 100 - outPct)}%` }}
            />
          </>
        ) : (
          <div
            className="editor-preview-scrubber-progress"
            style={{ width: `${playheadPct}%` }}
          />
        )}

        {trim ? (
          <>
            <button
              type="button"
              className="editor-preview-scrubber-handle is-in"
              style={{ left: `${inPct}%` }}
              aria-label="Set In point"
              title={`In ${trim.inSec.toFixed(1)}s`}
              disabled={disabled}
              onPointerDown={(e) => beginDrag("in", e)}
            />
            <button
              type="button"
              className="editor-preview-scrubber-handle is-out"
              style={{ left: `${outPct}%` }}
              aria-label="Set Out point"
              title={`Out ${trim.outSec.toFixed(1)}s`}
              disabled={disabled}
              onPointerDown={(e) => beginDrag("out", e)}
            />
          </>
        ) : null}

        <div
          className="editor-preview-scrubber-playhead"
          style={{ left: `${playheadPct}%` }}
          aria-hidden
        >
          <button
            type="button"
            className="editor-preview-scrubber-playhead-grip"
            aria-label="Playhead"
            disabled={disabled}
            onPointerDown={(e) => beginDrag("playhead", e)}
          />
        </div>
      </div>
    </div>
  );
}
