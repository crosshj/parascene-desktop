import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

const MIN_RANGE_SEC = 0.1;
const NUDGE_SEC = 0.05;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.00";
  return sec.toFixed(2);
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.00";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

type DragHandle = "in" | "out" | "window";

/**
 * Dual-handle range picker for a video clip: scrub in/out, fine number
 * controls, and a looping preview of the selected region.
 */
export function LabVideoRangePicker({
  mediaUrl,
  inSec,
  outSec,
  onRangeChange,
}: {
  mediaUrl: string;
  inSec: number;
  outSec: number;
  onRangeChange: (next: { inSec: number; outSec: number }) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    handle: DragHandle;
    startX: number;
    inSec: number;
    outSec: number;
  } | null>(null);
  const rangeRef = useRef({ inSec, outSec });
  const onRangeChangeRef = useRef(onRangeChange);

  const [durationSec, setDurationSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);

  useEffect(() => {
    onRangeChangeRef.current = onRangeChange;
  }, [onRangeChange]);
  useEffect(() => {
    rangeRef.current = { inSec, outSec };
  }, [inSec, outSec]);

  const dur = durationSec > 0 ? durationSec : 0;
  const safeIn = clamp(inSec, 0, Math.max(0, dur - MIN_RANGE_SEC));
  const safeOut =
    dur > 0
      ? clamp(outSec, safeIn + MIN_RANGE_SEC, dur)
      : Math.max(safeIn + MIN_RANGE_SEC, outSec);
  const span = Math.max(MIN_RANGE_SEC, safeOut - safeIn);

  const setRange = useCallback((nextIn: number, nextOut: number) => {
    const d = durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
    let a = clamp(nextIn, 0, Math.max(0, d - MIN_RANGE_SEC));
    let b = clamp(nextOut, a + MIN_RANGE_SEC, d);
    if (!(d === Number.POSITIVE_INFINITY) && b - a < MIN_RANGE_SEC) {
      b = Math.min(d, a + MIN_RANGE_SEC);
      a = Math.max(0, b - MIN_RANGE_SEC);
    }
    onRangeChangeRef.current({ inSec: a, outSec: b });
  }, [durationSec]);

  // Reset when the media source changes.
  useEffect(() => {
    // Intentional: clear duration / playback when switching videos.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDurationSec(0);
    setPlaying(false);
    setCurrentSec(0);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.load();
    }
  }, [mediaUrl]);

  // Keep in/out valid once we know duration.
  useEffect(() => {
    if (!(durationSec > 0)) return;
    const { inSec: a, outSec: b } = rangeRef.current;
    const nextIn = clamp(a, 0, Math.max(0, durationSec - MIN_RANGE_SEC));
    const nextOut = clamp(
      b > nextIn ? b : durationSec,
      nextIn + MIN_RANGE_SEC,
      durationSec,
    );
    if (
      Math.abs(nextIn - a) > 0.001 ||
      Math.abs(nextOut - b) > 0.001 ||
      !(b > a)
    ) {
      onRangeChangeRef.current({ inSec: nextIn, outSec: nextOut });
    }
  }, [durationSec]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        setDurationSec(video.duration);
      }
    };
    const onTime = () => {
      const t = video.currentTime;
      setCurrentSec(t);
      const { inSec: a, outSec: b } = rangeRef.current;
      if (t >= b - 0.04 || t < a - 0.02) {
        video.currentTime = a;
        setCurrentSec(a);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      video.currentTime = rangeRef.current.inSec;
      void video.play().catch(() => setPlaying(false));
    };

    video.addEventListener("loadedmetadata", syncDuration);
    video.addEventListener("durationchange", syncDuration);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    if (video.readyState >= 1) syncDuration();

    return () => {
      video.removeEventListener("loadedmetadata", syncDuration);
      video.removeEventListener("durationchange", syncDuration);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [mediaUrl]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const video = videoRef.current;
      if (video) setCurrentSec(video.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePreview = () => {
    const video = videoRef.current;
    if (!video || !(safeOut > safeIn)) return;
    if (video.paused) {
      video.currentTime = safeIn;
      setCurrentSec(safeIn);
      void video.play().catch(() => setPlaying(false));
    } else {
      video.pause();
    }
  };

  const secFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || !(dur > 0)) return 0;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * dur;
    },
    [dur],
  );

  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(dur > 0)) return;
    const target = event.target as HTMLElement;
    const handleAttr = target.closest("[data-handle]")?.getAttribute(
      "data-handle",
    ) as DragHandle | null;

    const pointerSec = secFromClientX(event.clientX);
    let handle: DragHandle = handleAttr ?? "window";
    let nextIn = safeIn;
    let nextOut = safeOut;

    if (!handleAttr) {
      if (pointerSec >= safeIn && pointerSec <= safeOut) {
        handle = "window";
      } else if (Math.abs(pointerSec - safeIn) <= Math.abs(pointerSec - safeOut)) {
        handle = "in";
        nextIn = pointerSec;
        setRange(pointerSec, safeOut);
      } else {
        handle = "out";
        nextOut = pointerSec;
        setRange(safeIn, pointerSec);
      }
    }

    dragRef.current = {
      handle,
      startX: event.clientX,
      inSec: nextIn,
      outSec: nextOut,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onTrackPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !(dur > 0)) return;
    if (drag.handle === "in") {
      setRange(secFromClientX(event.clientX), drag.outSec);
    } else if (drag.handle === "out") {
      setRange(drag.inSec, secFromClientX(event.clientX));
    } else {
      const deltaSec =
        ((event.clientX - drag.startX) / (trackRef.current?.clientWidth || 1)) *
        dur;
      const nextIn = clamp(drag.inSec + deltaSec, 0, Math.max(0, dur - span));
      setRange(nextIn, nextIn + span);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const inPct = dur > 0 ? (safeIn / dur) * 100 : 0;
  const outPct = dur > 0 ? (safeOut / dur) * 100 : 100;
  const playPct = dur > 0 ? (currentSec / dur) * 100 : 0;

  const nudge = (which: "in" | "out", delta: number) => {
    if (which === "in") setRange(safeIn + delta, safeOut);
    else setRange(safeIn, safeOut + delta);
  };

  return (
    <div className="lab-video-range">
      <div className="lab-video-range-preview">
        <video
          ref={videoRef}
          className="lab-video"
          src={mediaUrl}
          playsInline
          muted
          preload="metadata"
        />
        <div className="lab-video-range-preview-bar">
          <button
            type="button"
            className="lab-waveform-play"
            onClick={togglePreview}
            disabled={!(safeOut > safeIn) || !(dur > 0)}
            aria-label={playing ? "Pause region preview" : "Play region preview"}
            title={
              playing
                ? "Pause region preview"
                : "Play selected region on loop"
            }
          >
            {playing ? (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path fill="currentColor" d="M4 3h3v10H4zm5 0h3v10H9z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path fill="currentColor" d="M4 2.5v11l10-5.5z" />
              </svg>
            )}
          </button>
          <span className="muted lab-video-range-clock">
            {formatClock(currentSec)} / {formatClock(span)} selected ·{" "}
            {formatClock(dur)} total
          </span>
        </div>
      </div>

      <div
        ref={trackRef}
        className="lab-video-range-track"
        role="group"
        aria-label="Clip region"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="lab-video-range-track-bg" />
        <div
          className="lab-video-range-selection"
          style={{ left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%` }}
        />
        <div
          className="lab-video-range-playhead"
          style={{ left: `${playPct}%` }}
        />
        <button
          type="button"
          className="lab-video-range-handle is-in"
          data-handle="in"
          style={{ left: `${inPct}%` }}
          aria-label="Start handle"
        />
        <button
          type="button"
          className="lab-video-range-handle is-out"
          data-handle="out"
          style={{ left: `${outPct}%` }}
          aria-label="End handle"
        />
      </div>

      <div className="lab-video-range-fine">
        <label className="lab-video-range-fine-field">
          <span>Start (s)</span>
          <span className="lab-video-range-stepper">
            <button
              type="button"
              className="lab-secondary-btn"
              disabled={!(dur > 0)}
              onClick={() => nudge("in", -NUDGE_SEC)}
            >
              −
            </button>
            <input
              type="number"
              min={0}
              max={Math.max(0, dur - MIN_RANGE_SEC)}
              step={NUDGE_SEC}
              value={Number(formatSec(safeIn))}
              disabled={!(dur > 0)}
              onChange={(e) => setRange(Number(e.target.value) || 0, safeOut)}
            />
            <button
              type="button"
              className="lab-secondary-btn"
              disabled={!(dur > 0)}
              onClick={() => nudge("in", NUDGE_SEC)}
            >
              +
            </button>
          </span>
        </label>
        <label className="lab-video-range-fine-field">
          <span>End (s)</span>
          <span className="lab-video-range-stepper">
            <button
              type="button"
              className="lab-secondary-btn"
              disabled={!(dur > 0)}
              onClick={() => nudge("out", -NUDGE_SEC)}
            >
              −
            </button>
            <input
              type="number"
              min={MIN_RANGE_SEC}
              max={dur || undefined}
              step={NUDGE_SEC}
              value={Number(formatSec(safeOut))}
              disabled={!(dur > 0)}
              onChange={(e) => setRange(safeIn, Number(e.target.value) || 0)}
            />
            <button
              type="button"
              className="lab-secondary-btn"
              disabled={!(dur > 0)}
              onClick={() => nudge("out", NUDGE_SEC)}
            >
              +
            </button>
          </span>
        </label>
        <p className="muted lab-video-range-fine-meta">
          Length {formatSec(span)}s · step {NUDGE_SEC}s
        </p>
      </div>
    </div>
  );
}
