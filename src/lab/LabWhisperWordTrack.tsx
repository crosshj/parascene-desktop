import type { TranscriptWord } from "./transcribe";
import type { VocalBlock } from "./vocalBlocks";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Word-level Whisper transcript on the song timeline. */
export function LabWhisperWordTrack(props: {
  words: TranscriptWord[];
  durationSec: number;
  currentSec?: number;
  vocalBlocks?: VocalBlock[];
  /** Seek playhead when a word is selected. */
  onSeek?: (sec: number) => void;
  /** Render as a lane body only (no outer heading). */
  lane?: boolean;
}) {
  const {
    words,
    durationSec,
    currentSec = -1,
    vocalBlocks,
    onSeek,
    lane = false,
  } = props;
  if ((!words.length && !vocalBlocks?.length) || durationSec <= 0) return null;

  const track = (
    <div
      className={`lab-whisper-words-track${lane ? " lab-timeline-lane-body" : ""}`}
      role="list"
      aria-label="Whisper word timings"
    >
      {vocalBlocks?.map((block, index) => (
        <div
          key={`vocal-block-${index}-${block.startSec}`}
          className="lab-whisper-vocal-block"
          style={{
            left: `${(block.startSec / durationSec) * 100}%`,
            width: `${Math.max(
              0.5,
              ((block.endSec - block.startSec) / durationSec) * 100,
            )}%`,
          }}
          title={`Vocal section ${formatClock(block.startSec)}–${formatClock(block.endSec)}`}
        />
      ))}
      {words.map((w, index) => {
        const left = (w.startSec / durationSec) * 100;
        const width = Math.max(
          0.35,
          ((w.endSec - w.startSec) / durationSec) * 100,
        );
        const active =
          currentSec >= 0 && currentSec >= w.startSec && currentSec < w.endSec;
        return (
          <span
            key={`${index}-${w.word}-${w.startSec}`}
            role={onSeek ? "button" : "listitem"}
            tabIndex={onSeek ? 0 : undefined}
            className={[
              "lab-whisper-word",
              active ? "is-active" : "",
              onSeek ? "is-clickable" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`${w.word} · ${formatClock(w.startSec)}–${formatClock(w.endSec)}`}
            onClick={
              onSeek
                ? (e) => {
                    e.stopPropagation();
                    onSeek(w.startSec);
                  }
                : undefined
            }
            onKeyDown={
              onSeek
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSeek(w.startSec);
                    }
                  }
                : undefined
            }
          >
            {w.word.trim()}
          </span>
        );
      })}
      {currentSec >= 0 ? (
        <div
          className="lab-whisper-word-playhead"
          style={{ left: `${(currentSec / durationSec) * 100}%` }}
        />
      ) : null}
    </div>
  );

  if (lane) return track;

  return (
    <div className="lab-whisper-words">
      <div className="lab-whisper-words-head">
        <strong>Whisper words</strong>
        <span className="muted">{words.length} words</span>
      </div>
      {track}
    </div>
  );
}
