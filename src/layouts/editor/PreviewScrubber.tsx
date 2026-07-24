import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clearEditorBodyDragClasses,
  releasePointerCaptureSafe,
  subscribeGestureAbort,
} from "./gestureCleanup";
import { registerGestureStatusProvider } from "../../app/uiDiagnostics";

export type PreviewScrubberTrim = {
  inSec: number;
  outSec: number;
  /** Live preview while dragging — seek only, no timeline commit. */
  onLiveChange: (next: { inSec: number; outSec: number }) => void;
  /** Final values when the handle is released. */
  onCommit: (next: { inSec: number; outSec: number }) => void;
};

export type PreviewScrubberProps = {
  currentSec: number;
  durationSec: number;
  onSeek: (sec: number, options?: { trim?: boolean }) => void;
  disabled?: boolean;
  trim?: PreviewScrubberTrim | null;
};

const MIN_TRIM_SEC = 0.1;
/** Pointer slop (px) — cursor within this distance of a handle drags the handle. */
const HANDLE_HIT_PX = 12;

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

function tickMarks(durationSec: number): Array<{ t: number; major: boolean }> {
  if (!(durationSec > 0)) return [];
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
    const isMajor =
      Math.abs(clamped / majorStep - Math.round(clamped / majorStep)) < 1e-6;
    out.push({
      t: clamped,
      major: isMajor || clamped === 0 || clamped === durationSec,
    });
  }
  return out;
}

function pickTrimDragTarget(
  clientX: number,
  trackEl: HTMLElement,
  inPct: number,
  outPct: number,
): "in" | "out" | "playhead" {
  const rect = trackEl.getBoundingClientRect();
  if (rect.width <= 0) return "playhead";
  const x = clientX - rect.left;
  const inX = (inPct / 100) * rect.width;
  const outX = (outPct / 100) * rect.width;
  const inDist = Math.abs(x - inX);
  const outDist = Math.abs(x - outX);
  if (inDist <= HANDLE_HIT_PX && inDist <= outDist) return "in";
  if (outDist <= HANDLE_HIT_PX) return "out";
  return "playhead";
}

function handlesOverlapPlayhead(
  playheadPct: number,
  inPct: number,
  outPct: number,
  trackWidthPx: number,
): { in: boolean; out: boolean } {
  if (trackWidthPx <= 0) return { in: false, out: false };
  const playheadPx = (playheadPct / 100) * trackWidthPx;
  const inPx = (inPct / 100) * trackWidthPx;
  const outPx = (outPct / 100) * trackWidthPx;
  return {
    in: Math.abs(playheadPx - inPx) <= HANDLE_HIT_PX,
    out: Math.abs(playheadPx - outPx) <= HANDLE_HIT_PX,
  };
}

export function PreviewScrubber({
  currentSec,
  durationSec,
  onSeek,
  disabled = false,
  trim = null,
}: PreviewScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const captureTargetRef = useRef<HTMLElement | null>(null);
  const capturePointerIdRef = useRef<number | null>(null);
  const dragRef = useRef<"playhead" | "in" | "out" | null>(null);
  const liveTrimRef = useRef<{ inSec: number; outSec: number } | null>(
    trim ? { inSec: trim.inSec, outSec: trim.outSec } : null,
  );
  const trimRef = useRef(trim);
  const onSeekRef = useRef(onSeek);
  const applyDragRef = useRef<
    (clientX: number, kind: "playhead" | "in" | "out") => void
  >(() => {});
  const endDragRef = useRef<() => void>(() => {});
  const pointerListenersCleanupRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState<"playhead" | "in" | "out" | null>(
    null,
  );
  const [liveTrim, setLiveTrim] = useState<{ inSec: number; outSec: number } | null>(
    trim ? { inSec: trim.inSec, outSec: trim.outSec } : null,
  );
  const [trackWidthPx, setTrackWidthPx] = useState(0);

  useEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      const width = Math.max(0, Math.floor(el.getBoundingClientRect().width));
      setTrackWidthPx((prev) => (prev === width ? prev : width));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    trimRef.current = trim;
    onSeekRef.current = onSeek;
    if (!dragging) {
      liveTrimRef.current = trim
        ? { inSec: trim.inSec, outSec: trim.outSec }
        : null;
      // Sync committed trim into live state when not dragging.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLiveTrim(trim ? { inSec: trim.inSec, outSec: trim.outSec } : null);
    }
  }, [trim, onSeek, dragging]);

  const duration = Math.max(durationSec, 0.1);
  const displayTrim = liveTrim ?? trim;
  const playheadPct = clamp((currentSec / duration) * 100, 0, 100);
  const inPct = displayTrim
    ? clamp((displayTrim.inSec / duration) * 100, 0, 100)
    : 0;
  const outPct = displayTrim
    ? clamp((displayTrim.outSec / duration) * 100, 0, 100)
    : 100;
  const ticks = tickMarks(duration);
  const handleOverlap = displayTrim
    ? handlesOverlapPlayhead(playheadPct, inPct, outPct, trackWidthPx)
    : { in: false, out: false };
  const hidePlayheadGrip =
    dragging === "in" ||
    dragging === "out" ||
    (Boolean(displayTrim) && (handleOverlap.in || handleOverlap.out));

  const clearPointerListeners = useCallback(() => {
    pointerListenersCleanupRef.current?.();
    pointerListenersCleanupRef.current = null;
  }, []);

  const releaseCapture = useCallback(() => {
    releasePointerCaptureSafe(
      captureTargetRef.current,
      capturePointerIdRef.current,
    );
    captureTargetRef.current = null;
    capturePointerIdRef.current = null;
  }, []);

  const abortDrag = useCallback(
    (commit: boolean) => {
      clearPointerListeners();
      const kind = dragRef.current;
      if (commit && (kind === "in" || kind === "out")) {
        const live = liveTrimRef.current;
        const trimHandlers = trimRef.current;
        if (live && trimHandlers) {
          trimHandlers.onCommit(live);
        }
      }
      dragRef.current = null;
      setDragging(null);
      releaseCapture();
      clearEditorBodyDragClasses();
    },
    [clearPointerListeners, releaseCapture],
  );

  useEffect(() => subscribeGestureAbort(() => abortDrag(false)), [abortDrag]);

  useEffect(
    () =>
      registerGestureStatusProvider("previewScrubber", () => ({
        dragging: dragRef.current,
      })),
    [],
  );

  const applyDrag = useCallback(
    (clientX: number, kind: "playhead" | "in" | "out") => {
      const el = trackRef.current;
      if (!el) return;
      const sec = secFromClientX(clientX, el, duration);
      if (kind === "playhead") {
        onSeekRef.current(sec);
        return;
      }
      const live = liveTrimRef.current;
      const trimHandlers = trimRef.current;
      if (!live || !trimHandlers) return;
      if (kind === "in") {
        const inSec = clamp(sec, 0, live.outSec - MIN_TRIM_SEC);
        const next = { inSec, outSec: live.outSec };
        live.inSec = inSec;
        liveTrimRef.current = next;
        setLiveTrim(next);
        trimHandlers.onLiveChange(next);
        onSeekRef.current(inSec, { trim: true });
        return;
      }
      const outSec = clamp(sec, live.inSec + MIN_TRIM_SEC, duration);
      const next = { inSec: live.inSec, outSec };
      live.outSec = outSec;
      liveTrimRef.current = next;
      setLiveTrim(next);
      trimHandlers.onLiveChange(next);
      onSeekRef.current(outSec, { trim: true });
    },
    [duration],
  );

  useEffect(() => {
    applyDragRef.current = applyDrag;
  }, [applyDrag]);

  const endDrag = useCallback(() => {
    abortDrag(true);
  }, [abortDrag]);

  useEffect(() => {
    endDragRef.current = endDrag;
  }, [endDrag]);

  useEffect(() => () => abortDrag(false), [abortDrag]);

  const armPointerListeners = (pointerId: number) => {
    clearPointerListeners();
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const kind = dragRef.current;
      if (!kind) return;
      applyDragRef.current(event.clientX, kind);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      clearPointerListeners();
      endDragRef.current();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    pointerListenersCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const beginDrag = (
    kind: "playhead" | "in" | "out",
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (disabled) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    captureTargetRef.current = target;
    capturePointerIdRef.current = event.pointerId;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    dragRef.current = kind;
    setDragging(kind);
    if (kind === "in" || kind === "out") {
      document.body.classList.add("is-preview-trim-dragging");
    }
    armPointerListeners(event.pointerId);
    applyDragRef.current(event.clientX, kind);
  };

  const beginDragFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const trackEl = trackRef.current;
    if (displayTrim && trackEl) {
      beginDrag(pickTrimDragTarget(event.clientX, trackEl, inPct, outPct), event);
      return;
    }
    beginDrag("playhead", event);
  };

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    if (dragging === "in" || dragging === "out") return;
    if ((event.target as HTMLElement | null)?.closest(".editor-preview-scrubber-handle")) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest(".editor-preview-scrubber-playhead-grip")) {
      return;
    }
    beginDragFromPointer(event);
  };

  return (
    <div
      className={`editor-preview-scrubber${disabled ? " is-disabled" : ""}${
        displayTrim ? " has-trim" : ""
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
        {displayTrim ? (
          <>
            <div
              className="editor-preview-scrubber-shade is-before"
              style={{ width: `${inPct}%` }}
            />
            <div
              className="editor-preview-scrubber-range"
              style={{
                left: `${inPct}%`,
                width: `${Math.max(0, outPct - inPct)}%`,
              }}
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

        {displayTrim ? (
          <>
            <button
              type="button"
              className="editor-preview-scrubber-handle is-in"
              style={{ left: `${inPct}%` }}
              aria-label="Set In point"
              title={`In ${displayTrim.inSec.toFixed(1)}s`}
              disabled={disabled}
              onPointerDown={(e) => beginDrag("in", e)}
            />
            <button
              type="button"
              className="editor-preview-scrubber-handle is-out"
              style={{ left: `${outPct}%` }}
              aria-label="Set Out point"
              title={`Out ${displayTrim.outSec.toFixed(1)}s`}
              disabled={disabled}
              onPointerDown={(e) => beginDrag("out", e)}
            />
          </>
        ) : null}

        {!hidePlayheadGrip ? (
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
        ) : null}
      </div>
    </div>
  );
}
