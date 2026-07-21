import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AlignedLyricLine } from "../project/types";
import { audioWaveformPeaks } from "./audioTools";
import { LabWaveformPlayer } from "./LabMediaWaveform";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${ms}`;
}

function roundSec(n: number): number {
  return Number(n.toFixed(3));
}

type DragKind = "start" | "end" | null;

/** Full-mix playback + caption-style lyric blocks with manual timing edits. */
export function LabLyricCaptionEditor(props: {
  audioPath: string;
  mediaUrl: string;
  lines: AlignedLyricLine[];
  onChange: (lines: AlignedLyricLine[]) => void;
}) {
  const { audioPath, mediaUrl, lines, onChange } = props;
  const playerRef = useRef<{ seek: (sec: number) => void } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    index: number;
    kind: DragKind;
    pointerId: number;
  } | null>(null);

  const [durationSec, setDurationSec] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void audioWaveformPeaks(audioPath, 64).then((peaks) => {
      if (!cancelled && peaks.durationSec > 0) {
        setDurationSec(peaks.durationSec);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  const onTimeUpdate = useCallback((sec: number, dur: number) => {
    setCurrentSec(sec);
    if (dur > 0) setDurationSec(dur);
  }, []);

  const activeLineIndex = useMemo(() => {
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i];
      if (currentSec >= row.startSec && currentSec < row.endSec) return i;
    }
    return activeIndex;
  }, [lines, currentSec, activeIndex]);

  const seek = useCallback((sec: number) => {
    playerRef.current?.seek(clamp(sec, 0, durationSec || sec));
  }, [durationSec]);

  const updateLine = useCallback(
    (index: number, patch: Partial<AlignedLyricLine>) => {
      onChange(
        lines.map((row, i) => (i === index ? { ...row, ...patch } : row)),
      );
    },
    [lines, onChange],
  );

  const secToRatio = useCallback(
    (sec: number) => (durationSec > 0 ? clamp(sec / durationSec, 0, 1) : 0),
    [durationSec],
  );

  const ratioToSec = useCallback(
    (ratio: number) => (durationSec > 0 ? clamp(ratio, 0, 1) * durationSec : 0),
    [durationSec],
  );

  const onTrackPointerDown = (
    index: number,
    kind: DragKind,
    event: React.PointerEvent,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { index, kind, pointerId: event.pointerId };
    setActiveIndex(index);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onTrackPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const track = trackRef.current;
    if (!track || durationSec <= 0) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const sec = roundSec(ratioToSec(ratio));
    const row = lines[drag.index];
    if (!row) return;
    if (drag.kind === "start") {
      updateLine(drag.index, {
        startSec: Math.min(sec, row.endSec - 0.05),
      });
    } else if (drag.kind === "end") {
      updateLine(drag.index, {
        endSec: Math.max(sec, row.startSec + 0.05),
      });
    }
  };

  const onTrackPointerUp = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="lab-lyric-caption-editor">
      <LabWaveformPlayer
        path={audioPath}
        mediaUrl={mediaUrl}
        onTimeUpdate={onTimeUpdate}
        controlsRef={playerRef}
      />

      <div className="lab-lyric-caption-meta">
        <span className="muted">
          Playhead: {formatClock(currentSec)}
          {durationSec > 0 ? ` / ${formatClock(durationSec)}` : ""}
        </span>
        {activeLineIndex != null && lines[activeLineIndex] ? (
          <span className="lab-lyric-caption-now">
            Now: {lines[activeLineIndex].line}
          </span>
        ) : null}
      </div>

      <div
        ref={trackRef}
        className="lab-lyric-caption-track"
        onPointerMove={onTrackPointerMove}
        onPointerUp={onTrackPointerUp}
        onPointerCancel={onTrackPointerUp}
        onClick={(e) => {
          const track = trackRef.current;
          if (!track || durationSec <= 0) return;
          const rect = track.getBoundingClientRect();
          seek(ratioToSec((e.clientX - rect.left) / rect.width));
        }}
        role="presentation"
      >
        {durationSec > 0
          ? lines.map((row, index) => {
              const left = `${secToRatio(row.startSec) * 100}%`;
              const width = `${Math.max(
                0.4,
                (secToRatio(row.endSec) - secToRatio(row.startSec)) * 100,
              )}%`;
              const isActive = index === activeLineIndex;
              return (
                <div
                  key={`${index}-${row.line.slice(0, 12)}`}
                  className={`lab-lyric-caption-block${isActive ? " is-active" : ""}`}
                  style={{ left, width }}
                  title={row.line}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveIndex(index);
                    seek(row.startSec);
                  }}
                >
                  <button
                    type="button"
                    className="lab-lyric-caption-handle lab-lyric-caption-handle-start"
                    aria-label={`Adjust start for line ${index + 1}`}
                    onPointerDown={(e) => onTrackPointerDown(index, "start", e)}
                  />
                  <span className="lab-lyric-caption-block-label">{row.line}</span>
                  <button
                    type="button"
                    className="lab-lyric-caption-handle lab-lyric-caption-handle-end"
                    aria-label={`Adjust end for line ${index + 1}`}
                    onPointerDown={(e) => onTrackPointerDown(index, "end", e)}
                  />
                </div>
              );
            })
          : null}
        <div
          className="lab-lyric-caption-playhead"
          style={{ left: `${secToRatio(currentSec) * 100}%` }}
        />
      </div>

      <ol className="lab-lyric-caption-lines">
        {lines.map((row, index) => (
          <li
            key={`${index}-${row.line}`}
            className={index === activeLineIndex ? "is-active" : undefined}
          >
            <div className="lab-lyric-caption-line-times">
              <label>
                Start
                <input
                  type="number"
                  min={0}
                  max={durationSec || undefined}
                  step={0.01}
                  value={row.startSec}
                  onChange={(e) =>
                    updateLine(index, {
                      startSec: roundSec(Number(e.target.value) || 0),
                    })
                  }
                />
              </label>
              <label>
                End
                <input
                  type="number"
                  min={0}
                  max={durationSec || undefined}
                  step={0.01}
                  value={row.endSec}
                  onChange={(e) =>
                    updateLine(index, {
                      endSec: roundSec(Number(e.target.value) || 0),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className="btn subtle"
                onClick={() => updateLine(index, { startSec: roundSec(currentSec) })}
              >
                Start ← playhead
              </button>
              <button
                type="button"
                className="btn subtle"
                onClick={() => updateLine(index, { endSec: roundSec(currentSec) })}
              >
                End ← playhead
              </button>
              <button
                type="button"
                className="btn subtle"
                onClick={() => seek(row.startSec)}
              >
                Play
              </button>
            </div>
            <p className="lab-lyric-caption-line-text">{row.line}</p>
            {row.confidence != null ? (
              <p className="muted lab-lyric-caption-confidence">
                Confidence: {Math.round(row.confidence * 100)}%
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
