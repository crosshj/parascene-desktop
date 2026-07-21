import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ProposedScene,
  StoryboardProposal,
  StoryboardShotType,
} from "../project/types";
import { STORYBOARD_SHOT_TYPES } from "./storyboardShotCatalog";
import { LabWaveformStrip, PlayPauseIcon } from "./LabMediaWaveform";
import { LabStoryboardPreview } from "./LabStoryboardPreview";
import {
  visualGroupBlockColor,
  visualGroupSwatchColor,
} from "./storyboardVisualGroups";
import type { AlignedLyricLine } from "../project/types";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function LabStoryboardEditor(props: {
  proposal: StoryboardProposal;
  mixPath: string | null;
  mixUrl: string | null;
  vocalsMediaUrl?: string | null;
  lyricLines?: AlignedLyricLine[];
  onChange: (scenes: ProposedScene[]) => void;
}) {
  const { proposal, mixPath, mixUrl, vocalsMediaUrl, lyricLines, onChange } =
    props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const durationSec = proposal.durationSec;
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackSource, setPlaybackSource] = useState<"mix" | "vocals">("mix");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragRef = useRef<{
    sceneId: string;
    edge: "start" | "end";
    pointerId: number;
  } | null>(null);

  const effectivePlaybackSource =
    playbackSource === "vocals" && vocalsMediaUrl ? "vocals" : "mix";
  const activeMediaUrl =
    effectivePlaybackSource === "vocals" ? vocalsMediaUrl : mixUrl;

  const scenes = proposal.scenes;
  const scenesRef = useRef(scenes);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    scenesRef.current = scenes;
    onChangeRef.current = onChange;
  }, [scenes, onChange]);
  const selected = scenes.find((s) => s.id === selectedId) ?? null;

  const updateScene = useCallback((id: string, patch: Partial<ProposedScene>) => {
    onChangeRef.current(
      scenesRef.current.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );
  }, []);

  const seek = useCallback(
    (sec: number) => {
      const next = clamp(sec, 0, durationSec || sec);
      setCurrentSec(next);
      const audio = audioRef.current;
      if (audio) audio.currentTime = next;
    },
    [durationSec],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeMediaUrl) return;
    const onTime = () => setCurrentSec(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, [activeMediaUrl]);

  const activeSceneId = useMemo(() => {
    const hit = scenes.find(
      (s) => currentSec >= s.startSec && currentSec < s.endSec,
    );
    return hit?.id ?? null;
  }, [scenes, currentSec]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const sec = pct * durationSec;
      const scene = scenesRef.current.find((s) => s.id === drag.sceneId);
      if (!scene) return;
      if (drag.edge === "start") {
        const endSec = Math.max(scene.endSec - 0.25, sec);
        updateScene(drag.sceneId, {
          startSec: Math.min(endSec - 0.1, sec),
        });
      } else {
        const startSec = Math.min(scene.startSec + 0.25, sec);
        updateScene(drag.sceneId, {
          endSec: Math.max(startSec + 0.1, sec),
        });
      }
    },
    [durationSec, updateScene],
  );

  const endDrag = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
  };

  return (
    <div className="lab-storyboard-editor">
      <audio ref={audioRef} src={activeMediaUrl ?? undefined} preload="metadata" />

      <LabStoryboardPreview
        proposal={proposal}
        currentSec={currentSec}
        playing={playing}
        lyricLines={lyricLines}
      />

      <div className="lab-storyboard-transport">
        <button
          type="button"
          className="lab-waveform-play lab-timeline-play"
          disabled={!activeMediaUrl}
          onClick={() => {
            const audio = audioRef.current;
            if (!audio) return;
            if (audio.paused) void audio.play();
            else audio.pause();
          }}
          aria-label={playing ? "Pause" : "Play"}
          title={playing ? "Pause" : "Play"}
        >
          <PlayPauseIcon playing={playing} />
        </button>
        <span className="lab-storyboard-clock">
          {formatClock(currentSec)} / {formatClock(durationSec)}
        </span>
        <div className="lab-playback-source-toggle" role="group" aria-label="Playback source">
          <button
            type="button"
            className={effectivePlaybackSource === "mix" ? "is-active" : ""}
            onClick={() => setPlaybackSource("mix")}
            disabled={!mixUrl}
          >
            Full
          </button>
          <button
            type="button"
            className={effectivePlaybackSource === "vocals" ? "is-active" : ""}
            onClick={() => setPlaybackSource("vocals")}
            disabled={!vocalsMediaUrl}
          >
            Vocals
          </button>
        </div>
      </div>

      {mixPath ? (
        <LabWaveformStrip
          path={mixPath}
          currentSec={currentSec}
          durationSec={durationSec}
          onSeek={seek}
        />
      ) : null}

      <div
        className="lab-storyboard-scene-track"
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          seek(pct * durationSec);
        }}
        role="presentation"
      >
        {lyricLines?.map((line, i) => (
          <div
            key={`lyric-${i}-${line.startSec}`}
            className="lab-storyboard-lyric-ghost"
            style={{
              left: `${(line.startSec / durationSec) * 100}%`,
              width: `${Math.max(
                0.3,
                ((line.endSec - line.startSec) / durationSec) * 100,
              )}%`,
            }}
          />
        ))}
        {scenes.map((scene) => (
          <div
            key={scene.id}
            className={[
              "lab-storyboard-scene-block",
              scene.id === activeSceneId ? "is-active" : "",
              scene.id === selectedId ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{
              left: `${(scene.startSec / durationSec) * 100}%`,
              width: `${Math.max(
                0.5,
                ((scene.endSec - scene.startSec) / durationSec) * 100,
              )}%`,
              background: visualGroupBlockColor(
                proposal.visualGroups,
                scene.visualGroupId,
              ),
            }}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedId(scene.id);
              seek(scene.startSec);
            }}
            title={`${scene.shotType} ${formatClock(scene.startSec)}–${formatClock(scene.endSec)}`}
          >
            <span className="lab-storyboard-scene-label">
              {scene.title || scene.shotType}
            </span>
            <span
              className="lab-storyboard-handle lab-storyboard-handle-start"
              onPointerDown={(e) => {
                e.stopPropagation();
                dragRef.current = {
                  sceneId: scene.id,
                  edge: "start",
                  pointerId: e.pointerId,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
            />
            <span
              className="lab-storyboard-handle lab-storyboard-handle-end"
              onPointerDown={(e) => {
                e.stopPropagation();
                dragRef.current = {
                  sceneId: scene.id,
                  edge: "end",
                  pointerId: e.pointerId,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
            />
          </div>
        ))}
        <div
          className="lab-storyboard-playhead"
          style={{ left: `${(currentSec / durationSec) * 100}%` }}
        />
      </div>

      {proposal.visualGroups.length > 0 ? (
        <div className="lab-storyboard-legend" aria-label="Timeline key">
          <span className="lab-storyboard-legend-title">Key</span>
          <ul className="lab-storyboard-legend-groups">
            {proposal.visualGroups.map((group, index) => (
              <li key={group.id}>
                <span
                  className="lab-storyboard-legend-swatch"
                  style={{ background: visualGroupSwatchColor(index) }}
                  aria-hidden
                />
                <span className="lab-storyboard-legend-label">{group.label}</span>
                <span className="muted lab-storyboard-legend-method">
                  {group.productionMethod.replace(/_/g, " ")}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted lab-storyboard-legend-notes">
            Block colors are visual groups — scenes in the same group share base
            assets. Lavender outline = playing now. White inset = selected for
            edit. Faint bands = sung lyrics.
          </p>
        </div>
      ) : null}

      {selected ? (
        <div className="lab-storyboard-inspector lab-form">
          <h4>Scene</h4>
          <label>
            Shot type
            <select
              value={selected.shotType}
              onChange={(e) =>
                updateScene(selected.id, {
                  shotType: e.target.value as StoryboardShotType,
                })
              }
            >
              {STORYBOARD_SHOT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start (sec)
            <input
              type="number"
              step="0.1"
              value={selected.startSec}
              onChange={(e) =>
                updateScene(selected.id, { startSec: Number(e.target.value) })
              }
            />
          </label>
          <label>
            End (sec)
            <input
              type="number"
              step="0.1"
              value={selected.endSec}
              onChange={(e) =>
                updateScene(selected.id, { endSec: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Director note
            <textarea
              rows={2}
              value={selected.note}
              onChange={(e) =>
                updateScene(selected.id, { note: e.target.value })
              }
            />
          </label>
          <label>
            Prompt hint
            <textarea
              rows={3}
              value={selected.promptHint}
              onChange={(e) =>
                updateScene(selected.id, { promptHint: e.target.value })
              }
            />
          </label>
          {selected.vocalSliceWarning ? (
            <p className="lab-storyboard-warning">{selected.vocalSliceWarning}</p>
          ) : null}
        </div>
      ) : null}

      <table className="lab-storyboard-checklist">
        <thead>
          <tr>
            <th>Time</th>
            <th>Shot</th>
            <th>Method</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {scenes.map((s) => (
            <tr
              key={s.id}
              className={s.id === activeSceneId ? "is-active" : ""}
              onClick={() => {
                setSelectedId(s.id);
                seek(s.startSec);
              }}
            >
              <td>
                {formatClock(s.startSec)}–{formatClock(s.endSec)}
              </td>
              <td>{s.shotType}</td>
              <td>{s.productionMethod ?? "—"}</td>
              <td>{s.note.slice(0, 48)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
