import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AlignedLyricLine } from "../project/types";
import { audioWaveformPeaks } from "./audioTools";
import { isInaudibleLyricLine } from "./lyricAlign";
import { LabWaveformStrip, PlayPauseIcon } from "./LabMediaWaveform";
import { LabWhisperWordTrack } from "./LabWhisperWordTrack";
import type { TranscriptWord } from "./transcribe";

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

function LaneHead(props: { label: string; controls?: ReactNode }) {
  return (
    <div className="lab-timeline-lane-head">
      <span className="lab-timeline-lane-label">{props.label}</span>
      {props.controls ? (
        <div className="lab-timeline-lane-controls">{props.controls}</div>
      ) : null}
    </div>
  );
}

/** Caption timeline + aligned waveform lanes sharing one playhead. */
export function LabLyricCaptionEditor(props: {
  audioPath: string | null;
  mediaUrl: string | null;
  vocalsMediaUrl?: string | null;
  vocalsPath?: string | null;
  lines: AlignedLyricLine[];
  onChange: (lines: AlignedLyricLine[]) => void;
  whisperWords?: TranscriptWord[];
  vocalBlocks?: Array<{ startSec: number; endSec: number }>;
  fullMixControls?: ReactNode;
  vocalsControls?: ReactNode;
  whisperControls?: ReactNode;
  lyricsControls?: ReactNode;
}) {
  const {
    audioPath,
    mediaUrl,
    vocalsMediaUrl,
    vocalsPath,
    lines,
    onChange,
    whisperWords,
    vocalBlocks,
    fullMixControls,
    vocalsControls,
    whisperControls,
    lyricsControls,
  } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    index: number;
    kind: DragKind;
    pointerId: number;
  } | null>(null);
  const playbackSwitchRef = useRef<{ sec: number; resume: boolean } | null>(
    null,
  );

  const [durationSec, setDurationSec] = useState(0);
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [playbackSource, setPlaybackSource] = useState<"mix" | "vocals">("mix");

  const activeMediaUrl =
    playbackSource === "vocals" && vocalsMediaUrl
      ? vocalsMediaUrl
      : mediaUrl;

  useEffect(() => {
    if (playbackSource === "vocals" && !vocalsMediaUrl) {
      setPlaybackSource("mix");
    }
  }, [playbackSource, vocalsMediaUrl]);

  useEffect(() => {
    let cancelled = false;
    if (!audioPath) {
      setDurationSec(0);
      return;
    }
    void audioWaveformPeaks(audioPath, 64).then((peaks) => {
      if (!cancelled && peaks.durationSec > 0) {
        setDurationSec(peaks.durationSec);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [audioPath]);

  const seek = useCallback(
    (sec: number) => {
      const next = clamp(sec, 0, durationSec || sec);
      const audio = audioRef.current;
      if (audio && Number.isFinite(next)) {
        audio.currentTime = next;
      }
      setCurrentSec(next);
    },
    [durationSec],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeMediaUrl) return;

    const applyPendingSeek = () => {
      const pending = playbackSwitchRef.current;
      if (!pending) return;
      audio.currentTime = pending.sec;
      setCurrentSec(pending.sec);
      playbackSwitchRef.current = null;
      if (pending.resume) {
        void audio.play().catch(() => setPlaying(false));
      }
    };

    const onTime = () => setCurrentSec(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentSec(0);
    };
    const syncDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDurationSec(audio.duration);
      }
      applyPendingSeek();
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("loadedmetadata", syncDuration);
    if (audio.readyState >= 1) syncDuration();

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("loadedmetadata", syncDuration);
    };
  }, [activeMediaUrl]);

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

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().catch(() => setPlaying(false));
    } else {
      audio.pause();
    }
  };

  const switchPlaybackSource = (next: "mix" | "vocals") => {
    if (next === playbackSource) return;
    if (next === "vocals" && !vocalsMediaUrl) return;
    const audio = audioRef.current;
    playbackSwitchRef.current = {
      sec: audio?.currentTime ?? currentSec,
      resume: playing,
    };
    if (audio && !audio.paused) audio.pause();
    setPlaybackSource(next);
  };

  const hasSungBlocks = lines.some((row) => !isInaudibleLyricLine(row));

  const activeLineIndex = useMemo(() => {
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i];
      if (isInaudibleLyricLine(row)) continue;
      if (currentSec >= row.startSec && currentSec < row.endSec) return i;
    }
    return activeIndex;
  }, [lines, currentSec, activeIndex]);

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
      {activeMediaUrl ? (
        <audio
          ref={audioRef}
          src={activeMediaUrl}
          preload="auto"
          className="sr-only"
        />
      ) : null}

      <div className="lab-lyric-caption-meta">
        <button
          type="button"
          className="lab-waveform-play lab-timeline-play"
          onClick={togglePlay}
          disabled={!activeMediaUrl}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          <PlayPauseIcon playing={playing} />
        </button>
        <div
          className="lab-playback-source-toggle"
          role="group"
          aria-label="Playback source"
        >
          <button
            type="button"
            className={playbackSource === "mix" ? "is-active" : ""}
            onClick={() => switchPlaybackSource("mix")}
            disabled={!mediaUrl}
            aria-pressed={playbackSource === "mix"}
          >
            Full
          </button>
          <button
            type="button"
            className={playbackSource === "vocals" ? "is-active" : ""}
            onClick={() => switchPlaybackSource("vocals")}
            disabled={!vocalsMediaUrl}
            aria-pressed={playbackSource === "vocals"}
            title={
              vocalsMediaUrl
                ? "Play vocals stem"
                : "Generate a vocals stem first"
            }
          >
            Vocals
          </button>
        </div>
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

      <div className="lab-timeline-stack">
        <div className="lab-timeline-lane">
          <LaneHead label="Full mix" controls={fullMixControls} />
          <div className="lab-timeline-lane-body">
            {audioPath ? (
              <LabWaveformStrip
                path={audioPath}
                currentSec={currentSec}
                durationSec={durationSec}
                onSeek={seek}
              />
            ) : (
              <div className="lab-timeline-lane-empty muted">
                Select main audio to show the full mix waveform.
              </div>
            )}
          </div>
        </div>

        <div className="lab-timeline-lane">
          <LaneHead label="Vocals stem" controls={vocalsControls} />
          <div className="lab-timeline-lane-body">
            {vocalsPath ? (
              <LabWaveformStrip
                path={vocalsPath}
                currentSec={currentSec}
                durationSec={durationSec}
                onSeek={seek}
              />
            ) : (
              <div className="lab-timeline-lane-empty muted">
                Generate a vocals stem to preview isolated vocals.
              </div>
            )}
          </div>
        </div>

        <div className="lab-timeline-lane">
          <LaneHead label="Whisper" controls={whisperControls} />
          <div className="lab-timeline-lane-body">
            {whisperWords && whisperWords.length > 0 && durationSec > 0 ? (
              <LabWhisperWordTrack
                words={whisperWords}
                durationSec={durationSec}
                currentSec={currentSec}
                vocalBlocks={vocalBlocks}
                onSeek={seek}
                lane
              />
            ) : vocalBlocks && vocalBlocks.length > 0 && durationSec > 0 ? (
              <LabWhisperWordTrack
                words={[]}
                durationSec={durationSec}
                currentSec={currentSec}
                vocalBlocks={vocalBlocks}
                onSeek={seek}
                lane
              />
            ) : (
              <div className="lab-timeline-lane-empty lab-whisper-words-track muted">
                Detect words to show Whisper timings on the timeline.
              </div>
            )}
          </div>
        </div>

        <div className="lab-timeline-lane lab-timeline-lane-captions">
          <LaneHead label="Lyrics" controls={lyricsControls} />
          <div
            ref={trackRef}
            className="lab-timeline-lane-body lab-lyric-caption-track"
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
            {durationSec > 0 && hasSungBlocks
              ? lines.map((row, index) => {
                  if (isInaudibleLyricLine(row)) return null;
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
        </div>
      </div>

      {lines.length > 0 ? (
        <ol className="lab-lyric-caption-lines">
          {lines.map((row, index) => (
            <li
              key={`${index}-${row.line}`}
              className={[
                index === activeLineIndex ? "is-active" : "",
                isInaudibleLyricLine(row) ? "is-inaudible" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined}
            >
              {isInaudibleLyricLine(row) ? (
                <>
                  <p className="lab-lyric-caption-tag-label muted">Section tag</p>
                  <p className="lab-lyric-caption-line-text lab-lyric-caption-tag-text">
                    {row.line}
                  </p>
                </>
              ) : (
                <>
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
                      onClick={() =>
                        updateLine(index, { startSec: roundSec(currentSec) })
                      }
                    >
                      Start ← playhead
                    </button>
                    <button
                      type="button"
                      className="btn subtle"
                      onClick={() =>
                        updateLine(index, { endSec: roundSec(currentSec) })
                      }
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
                </>
              )}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
