import { useCallback, useEffect, useRef, useState } from "react";
import { audioWaveformPeaks } from "./audioTools";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function effectiveDuration(
  audioDuration: number,
  decodedDuration: number,
): number {
  if (Number.isFinite(audioDuration) && audioDuration > 0) return audioDuration;
  if (Number.isFinite(decodedDuration) && decodedDuration > 0) {
    return decodedDuration;
  }
  return 0;
}

function drawPeaks(
  canvas: HTMLCanvasElement,
  peaks: number[],
  progress: number,
  range?: { start: number; end: number } | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 48;
  if (cssW <= 0 || cssH <= 0) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (range && range.end > range.start) {
    const x0 = clamp(range.start, 0, 1) * cssW;
    const x1 = clamp(range.end, 0, 1) * cssW;
    ctx.fillStyle = "rgba(168, 85, 247, 0.18)";
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssH);
    ctx.strokeStyle = "rgba(168, 85, 247, 0.9)";
    ctx.lineWidth = 1.5;
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
  }

  const mid = cssH / 2;
  const gap = 1;
  const barW = Math.max(1, (cssW - gap * (peaks.length - 1)) / peaks.length);
  const playedBars = Math.floor(progress * peaks.length);

  peaks.forEach((p, i) => {
    const h = Math.max(2, p * (cssH * 0.9));
    const x = i * (barW + gap);
    const y = mid - h / 2;
    ctx.fillStyle =
      i <= playedBars
        ? "rgba(168, 85, 247, 0.95)"
        : "rgba(138, 180, 255, 0.55)";
    ctx.fillRect(x, y, barW, h);
  });

  const headX = clamp(progress, 0, 1) * cssW;
  ctx.strokeStyle = "#e9d5ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headX, 0);
  ctx.lineTo(headX, cssH);
  ctx.stroke();

  ctx.fillStyle = "#e9d5ff";
  ctx.beginPath();
  ctx.arc(headX, 4, 4, 0, Math.PI * 2);
  ctx.fill();
}

function PlayPauseIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M4 3h3v10H4zm5 0h3v10H9z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path fill="currentColor" d="M4 2.5v11l10-5.5z" />
    </svg>
  );
}

/** Interactive waveform scrubber with play/pause and click-to-seek. */
export function LabWaveformPlayer({
  path,
  mediaUrl,
}: {
  path: string;
  mediaUrl: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<number[] | null>(null);
  const progressRef = useRef(0);
  const dragRef = useRef(false);
  const decodedDurationRef = useRef(0);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  // Fallback to the Rust-decoded duration (a ref) when audio metadata is slow.
  // eslint-disable-next-line react-hooks/refs
  const trackDuration = effectiveDuration(durationSec, decodedDurationRef.current);

  useEffect(() => {
    peaksRef.current = peaks;
  }, [peaks]);

  useEffect(() => {
    progressRef.current =
      trackDuration > 0 ? clamp(currentSec / trackDuration, 0, 1) : 0;
  }, [currentSec, trackDuration]);

  useEffect(() => {
    let cancelled = false;
    // Intentional: reset playback state whenever the audio path changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPeaks(null);
    setError(null);
    setPlaying(false);
    setCurrentSec(0);
    setDurationSec(0);
    decodedDurationRef.current = 0;
    void audioWaveformPeaks(path, 160)
      .then((next) => {
        if (cancelled) return;
        decodedDurationRef.current = next.durationSec;
        setPeaks(next.peaks);
        if (next.durationSec > 0) {
          setDurationSec((prev) =>
            prev > 0 ? prev : next.durationSec,
          );
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPeaks(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const rangeRatio = null;

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const currentPeaks = peaksRef.current;
    if (!canvas || !currentPeaks?.length) return;
    drawPeaks(canvas, currentPeaks, progressRef.current, rangeRatio);
  }, [rangeRatio]);

  useEffect(() => {
    redraw();
  }, [peaks, currentSec, trackDuration, rangeRatio, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks?.length) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, redraw]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !peaks) return;

    const syncDuration = () => {
      const dur = effectiveDuration(
        audio.duration,
        decodedDurationRef.current,
      );
      if (dur > 0) setDurationSec(dur);
    };
    const onTime = () => setCurrentSec(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentSec(0);
    };

    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    if (audio.readyState >= 1) syncDuration();

    return () => {
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [mediaUrl, peaks]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentSec(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seekToRatio = useCallback(
    (ratio: number) => {
      const audio = audioRef.current;
      const dur = audio
        ? effectiveDuration(audio.duration, decodedDurationRef.current)
        : trackDuration;
      if (!(dur > 0)) return;
      const sec = clamp(ratio, 0, 1) * dur;
      if (audio) audio.currentTime = sec;
      setCurrentSec(sec);
      progressRef.current = sec / dur;
      redraw();
    },
    [trackDuration, redraw],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = (clientX - rect.left) / rect.width;
      seekToRatio(ratio);
    },
    [seekToRatio],
  );

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setPlaying(true);
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  return (
    <div className="lab-waveform-player">
      <audio ref={audioRef} src={mediaUrl} preload="auto" />
      {error ? (
        <div className="lab-waveform is-error" title={error}>
          Waveform unavailable
        </div>
      ) : !peaks ? (
        <div className="lab-waveform is-loading">Loading waveform…</div>
      ) : (
        <>
          <button
            type="button"
            className="lab-waveform-play"
            onClick={togglePlay}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
          >
            <PlayPauseIcon playing={playing} />
          </button>
          <div className="lab-waveform-scrub-wrap">
            <canvas
              ref={canvasRef}
              className="lab-waveform lab-waveform-interactive"
              role="slider"
              aria-label="Audio scrubber"
              aria-valuemin={0}
              aria-valuemax={Math.round(trackDuration * 100) / 100}
              aria-valuenow={Math.round(currentSec * 100) / 100}
              aria-valuetext={`${formatClock(currentSec)} of ${formatClock(trackDuration)}`}
              tabIndex={0}
              onPointerDown={(event) => {
                dragRef.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                seekFromClientX(event.clientX);
              }}
              onPointerMove={(event) => {
                if (!dragRef.current) return;
                seekFromClientX(event.clientX);
              }}
              onPointerUp={(event) => {
                dragRef.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                dragRef.current = false;
              }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 5 : 1;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  seekToRatio(
                    (trackDuration > 0 ? currentSec / trackDuration : 0) -
                      step / Math.max(trackDuration, 1),
                  );
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  seekToRatio(
                    (trackDuration > 0 ? currentSec / trackDuration : 0) +
                      step / Math.max(trackDuration, 1),
                  );
                } else if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  togglePlay();
                }
              }}
            />
            <span className="lab-waveform-time muted" aria-hidden>
              {formatClock(currentSec)} / {formatClock(trackDuration)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function LabAudioTrack({
  label,
  path,
  mediaUrl,
  hint,
}: {
  label: string;
  path: string | null;
  mediaUrl: string | null;
  hint?: string;
}) {
  if (!path || !mediaUrl) return null;
  return (
    <div className="lab-audio-track">
      <div className="lab-audio-track-head">
        <strong>{label}</strong>
        {hint ? <span className="muted">{hint}</span> : null}
      </div>
      <LabWaveformPlayer path={path} mediaUrl={mediaUrl} />
    </div>
  );
}

const MIN_CLIP_SEC = 0.1;

function drawSliceWindow(
  canvas: HTMLCanvasElement,
  peaks: number[],
  startRatio: number,
  endRatio: number,
  progressRatio = -1,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 64;
  if (cssW <= 0 || cssH <= 0) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const xStart = clamp(startRatio, 0, 1) * cssW;
  const xEnd = clamp(endRatio, 0, 1) * cssW;
  const selLeft = Math.min(xStart, xEnd);
  const selRight = Math.max(xStart, xEnd);

  ctx.fillStyle = "rgba(10, 12, 16, 0.45)";
  ctx.fillRect(0, 0, selLeft, cssH);
  ctx.fillRect(selRight, 0, cssW - selRight, cssH);

  ctx.fillStyle = "rgba(45, 212, 191, 0.12)";
  ctx.fillRect(selLeft, 0, Math.max(1, selRight - selLeft), cssH);

  const mid = cssH / 2;
  const gap = 1;
  const barW = Math.max(1, (cssW - gap * (peaks.length - 1)) / peaks.length);
  const headX =
    progressRatio >= 0 ? clamp(progressRatio, 0, 1) * cssW : -1;

  peaks.forEach((p, i) => {
    const barCenter = i * (barW + gap) + barW / 2;
    const inside = barCenter >= selLeft && barCenter <= selRight;
    const played = headX >= 0 && barCenter <= headX;
    const h = Math.max(2, p * (cssH * 0.88));
    const x = i * (barW + gap);
    const y = mid - h / 2;
    ctx.fillStyle = !inside
      ? "rgba(138, 180, 255, 0.35)"
      : played
        ? "rgba(20, 184, 166, 1)"
        : "rgba(45, 212, 191, 0.95)";
    ctx.fillRect(x, y, barW, h);
  });

  if (headX >= 0) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(headX, 0);
    ctx.lineTo(headX, cssH);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(headX, 5, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Fixed-length sliding window on a waveform for slice selection. */
export function LabWaveformSlicePicker({
  path,
  mediaUrl,
  clipLengthSec,
  startSec,
  onStartChange,
}: {
  path: string;
  mediaUrl: string;
  clipLengthSec: number;
  startSec: number;
  onStartChange: (startSec: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaksRef = useRef<number[] | null>(null);
  const dragRef = useRef(false);
  const dragAnchorRef = useRef({ startSec: 0, pointerSec: 0 });
  const decodedDurationRef = useRef(0);
  const progressRef = useRef(-1);
  const onStartChangeRef = useRef(onStartChange);
  const startSecRef = useRef(startSec);
  const clipLengthRef = useRef(clipLengthSec);

  useEffect(() => {
    onStartChangeRef.current = onStartChange;
  }, [onStartChange]);
  useEffect(() => {
    startSecRef.current = startSec;
  }, [startSec]);
  useEffect(() => {
    clipLengthRef.current = clipLengthSec;
  }, [clipLengthSec]);

  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);

  // Fallback to the Rust-decoded duration (a ref) when audio metadata is slow.
  // eslint-disable-next-line react-hooks/refs
  const trackDuration = effectiveDuration(durationSec, decodedDurationRef.current);
  const clipLen = Math.max(MIN_CLIP_SEC, clipLengthSec);
  const inSec = startSec;
  const outSec = Math.min(startSec + clipLen, trackDuration || startSec + clipLen);
  const startRatio = trackDuration > 0 ? clamp(inSec / trackDuration, 0, 1) : 0;
  const endRatio = trackDuration > 0 ? clamp(outSec / trackDuration, 0, 1) : 0;

  useEffect(() => {
    progressRef.current =
      playing || currentSec > 0 ? currentSec : -1;
  }, [currentSec, playing]);

  const clampStart = useCallback(
    (nextStart: number, len = clipLen, dur = trackDuration) => {
      if (!(dur > 0)) return 0;
      const span = Math.min(len, dur);
      return clamp(nextStart, 0, Math.max(0, dur - span));
    },
    [clipLen, trackDuration],
  );

  useEffect(() => {
    peaksRef.current = peaks;
  }, [peaks]);

  useEffect(() => {
    if (!(trackDuration > 0)) return;
    const clamped = clampStart(startSecRef.current, clipLengthRef.current, trackDuration);
    if (clamped !== startSecRef.current) {
      onStartChangeRef.current(clamped);
    }
  }, [trackDuration, clipLengthSec, clampStart]);

  useEffect(() => {
    let cancelled = false;
    // Intentional: reset playback state whenever the audio path changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPeaks(null);
    setError(null);
    setPlaying(false);
    setDurationSec(0);
    setCurrentSec(0);
    progressRef.current = -1;
    decodedDurationRef.current = 0;
    void audioWaveformPeaks(path, 200)
      .then((next) => {
        if (cancelled) return;
        decodedDurationRef.current = next.durationSec;
        setPeaks(next.peaks);
        if (next.durationSec > 0) {
          setDurationSec(next.durationSec);
          const clamped = clamp(
            startSecRef.current,
            0,
            Math.max(0, next.durationSec - Math.min(clipLengthRef.current, next.durationSec)),
          );
          if (clamped !== startSecRef.current) {
            onStartChangeRef.current(clamped);
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setPeaks(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const currentPeaks = peaksRef.current;
    if (!canvas || !currentPeaks?.length) return;
    const ratio =
      trackDuration > 0 && progressRef.current >= 0
        ? clamp(progressRef.current / trackDuration, 0, 1)
        : -1;
    drawSliceWindow(canvas, currentPeaks, startRatio, endRatio, ratio);
  }, [startRatio, endRatio, trackDuration]);

  useEffect(() => {
    redraw();
  }, [peaks, startRatio, endRatio, currentSec, playing, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks?.length) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, redraw]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !peaks) return;

    const syncDuration = () => {
      const dur = effectiveDuration(audio.duration, decodedDurationRef.current);
      if (dur > 0) setDurationSec(dur);
    };
    const onTime = () => {
      setCurrentSec(audio.currentTime);
      if (audio.currentTime >= outSec - 0.02) {
        audio.currentTime = inSec;
        setCurrentSec(inSec);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);

    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    if (audio.readyState >= 1) syncDuration();

    return () => {
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [mediaUrl, peaks, inSec, outSec]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const audio = audioRef.current;
      if (audio) setCurrentSec(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const secFromClientX = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !(trackDuration > 0)) return 0;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * trackDuration;
    },
    [trackDuration],
  );

  const slideFromPointer = useCallback(
    (clientX: number) => {
      const pointerSec = secFromClientX(clientX);
      const delta = pointerSec - dragAnchorRef.current.pointerSec;
      onStartChangeRef.current(
        clampStart(dragAnchorRef.current.startSec + delta),
      );
    },
    [clampStart, secFromClientX],
  );

  const pointerInWindow = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !(trackDuration > 0)) return false;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const xStart = startRatio * rect.width;
      const xEnd = endRatio * rect.width;
      return x >= xStart && x <= xEnd;
    },
    [endRatio, startRatio, trackDuration],
  );

  const togglePreview = () => {
    const audio = audioRef.current;
    if (!audio || !(outSec > inSec)) return;
    if (audio.paused) {
      audio.currentTime = inSec;
      setCurrentSec(inSec);
      setPlaying(true);
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  if (error) {
    return (
      <div className="lab-waveform is-error" title={error}>
        Slice picker unavailable
      </div>
    );
  }
  if (!peaks) {
    return <div className="lab-waveform is-loading">Loading waveform…</div>;
  }

  return (
    <div className="lab-waveform-range">
      <audio ref={audioRef} src={mediaUrl} preload="auto" />
      <div className="lab-waveform-range-controls">
        <button
          type="button"
          className="lab-waveform-play"
          onClick={togglePreview}
          disabled={!(outSec > inSec)}
          aria-label={playing ? "Pause slice preview" : "Play slice preview"}
          title={playing ? "Pause slice preview" : "Play slice preview"}
        >
          <PlayPauseIcon playing={playing} />
        </button>
        <div className="lab-waveform-range-meta muted">
          <span>Start {formatClock(inSec)}</span>
          <span>End {formatClock(outSec)}</span>
          <span>Length {formatClock(clipLen)}</span>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="lab-waveform lab-waveform-range-canvas"
        role="group"
        aria-label="Slide clip section along waveform"
        onPointerDown={(event) => {
          const pointerSec = secFromClientX(event.clientX);
          dragRef.current = true;
          if (!pointerInWindow(event.clientX)) {
            const next = clampStart(pointerSec);
            onStartChangeRef.current(next);
            dragAnchorRef.current = { startSec: next, pointerSec };
          } else {
            dragAnchorRef.current = { startSec, pointerSec };
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          slideFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          dragRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = false;
        }}
      />
    </div>
  );
}
