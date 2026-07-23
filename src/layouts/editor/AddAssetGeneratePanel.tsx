import { useEffect, useMemo, useState } from "react";
import { LAB_A2V_PROMPT } from "../../lab/labPrompts";
import type { LyricAlignment, TimelineClip } from "../../project/types";
import {
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import {
  ADD_ASSET_NO_LYRICS_AUDIO_NOTE,
  addAssetGenerationProgress,
  resolveAddAssetAudioMode,
  type AddAssetAudioMode,
  type AddAssetGenerationSession,
} from "./addAssetGenerate";
import { resolveLyricsForTimeRange, matchingLyricAlignment } from "./addAssetLyrics";
import {
  clipSongTimeRangeFromTimeline,
  resolveAddAssetStartFrame,
  type StartFramePreview,
} from "./addAssetStartFrame";

export type StartAddAssetGenerationRequest = {
  clip: TimelineClip;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  startFrame: StartFramePreview;
};

type AddAssetGeneratePanelProps = {
  clip: TimelineClip;
  aspectRatio: ProjectAspectRatio;
  session: AddAssetGenerationSession | null;
  timeline: readonly TimelineClip[];
  lyricAlignment: LyricAlignment | null;
  mainAudioCreationId: string | null;
  onStartGeneration: (request: StartAddAssetGenerationRequest) => void;
  onClearError?: () => void;
};

type PanelPhase = "form" | "running" | "error";

function formatTimeRange(startSec: number, endSec: number): string {
  const fmt = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(1);
    return `${m}:${s.padStart(4, "0")}`;
  };
  return `${fmt(startSec)} – ${fmt(endSec)}`;
}

function GenerateActions({
  onRefresh,
  onGenerate,
  refreshDisabled,
  generateDisabled,
}: {
  onRefresh: () => void;
  onGenerate: () => void;
  refreshDisabled: boolean;
  generateDisabled: boolean;
}) {
  return (
    <div className="add-asset-generate-footer">
      <button
        type="button"
        className="btn ghost"
        onClick={onRefresh}
        disabled={refreshDisabled}
      >
        Refresh
      </button>
      <button
        type="button"
        className="btn btn-primary editor-add-asset-generate"
        disabled={generateDisabled}
        onClick={onGenerate}
      >
        Generate video
      </button>
    </div>
  );
}

function timelineFingerprint(timeline: readonly TimelineClip[]): string {
  return timeline
    .map(
      (clip) =>
        `${clip.id}:${clip.startSec.toFixed(3)}:${clip.endSec.toFixed(3)}:${clip.assetId ?? ""}:${clip.inSec ?? 0}:${clip.outSec ?? ""}`,
    )
    .join("|");
}

function AddAssetGenerationProgressBar({ startedAtMs }: { startedAtMs: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const { percent, indeterminate } = addAssetGenerationProgress(
    nowMs - startedAtMs,
  );

  return (
    <div
      className={`add-asset-generate-progress${
        indeterminate ? " is-indeterminate" : ""
      }`}
      role="progressbar"
      aria-label="Video generation progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
    >
      <span
        className="add-asset-generate-progress-bar"
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export function AddAssetGeneratePanel({
  clip,
  aspectRatio,
  session,
  timeline,
  lyricAlignment,
  mainAudioCreationId,
  onStartGeneration,
  onClearError,
}: AddAssetGeneratePanelProps) {
  const timelineKey = useMemo(() => timelineFingerprint(timeline), [timeline]);
  const [pullEpoch, setPullEpoch] = useState(0);

  const { songRange, lyricsText } = useMemo(() => {
    const range = clipSongTimeRangeFromTimeline(
      timeline,
      clip,
      mainAudioCreationId,
      lyricAlignment,
    );
    const aligned = matchingLyricAlignment(lyricAlignment);
    const text = aligned
      ? resolveLyricsForTimeRange(aligned, range.startSec, range.endSec)
      : "";
    return { songRange: range, lyricsText: text };
  }, [timeline, clip, mainAudioCreationId, lyricAlignment]);

  const [prompt, setPrompt] = useState(LAB_A2V_PROMPT);
  const [audioMode, setAudioMode] = useState<AddAssetAudioMode>(() =>
    resolveAddAssetAudioMode(""),
  );
  const [loadedStartFrame, setLoadedStartFrame] = useState<{
    key: string;
    preview: StartFramePreview | null;
  } | null>(null);
  const [prevLyricsText, setPrevLyricsText] = useState(lyricsText);
  if (lyricsText !== prevLyricsText) {
    setPrevLyricsText(lyricsText);
    setPrompt(LAB_A2V_PROMPT);
    setAudioMode(resolveAddAssetAudioMode(lyricsText));
    setPullEpoch(0);
    setLoadedStartFrame(null);
  }

  const startFrameKey = `${timelineKey}:${clip.id}:${pullEpoch}`;
  const activeSession = session?.clipId === clip.id ? session : null;
  const phase: PanelPhase = activeSession?.phase ?? "form";
  const startFrame =
    loadedStartFrame?.key === startFrameKey ? loadedStartFrame.preview : null;
  const startFrameLoading = phase === "form" && loadedStartFrame?.key !== startFrameKey;

  const hasLyrics = Boolean(lyricsText.trim());
  const resolvedAudioMode = hasLyrics ? audioMode : "full_mix";

  useEffect(() => {
    if (phase !== "form") return;
    let cancelled = false;
    void resolveAddAssetStartFrame(timeline, clip).then((preview) => {
      if (cancelled) return;
      setLoadedStartFrame({ key: startFrameKey, preview });
    });
    return () => {
      cancelled = true;
    };
  }, [timeline, clip, startFrameKey, phase]);

  const handleRefresh = () => {
    if (phase !== "form" || startFrameLoading) return;
    setLoadedStartFrame(null);
    setPullEpoch((epoch) => epoch + 1);
  };

  const handleGenerate = () => {
    if (phase !== "form" || !startFrame || !prompt.trim()) return;
    void resolveAddAssetStartFrame(timeline, clip).then((freshStartFrame) => {
      onStartGeneration({
        clip,
        prompt,
        lyricsText,
        audioMode: resolvedAudioMode,
        startFrame: freshStartFrame,
      });
    });
  };

  if (phase === "running" && activeSession) {
    return (
      <div
        className="add-asset-generate-pane"
        aria-busy
        aria-label="Generating video"
      >
        <div className="add-asset-generate-body">
          <AddAssetGenerationProgressBar startedAtMs={activeSession.startedAtMs} />
          <p className="add-asset-generate-progress-note muted">
            {activeSession.progressNote}
          </p>
          <ol className="add-asset-generate-steps add-asset-generate-running">
            {activeSession.steps.map((step) => (
              <li
                key={step.id}
                className={`add-asset-generate-step is-${step.status}`}
              >
                <span className="add-asset-generate-step-icon" aria-hidden>
                  {step.status === "done" ? (
                    "✓"
                  ) : step.status === "active" ? (
                    <span className="confirm-dialog-spinner" />
                  ) : (
                    "○"
                  )}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  if (phase === "error" && activeSession) {
    return (
      <div className="add-asset-generate-pane" role="alert">
        <div className="add-asset-generate-body">
          <p className="add-asset-generate-error">
            {activeSession.errorMessage}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onClearError?.()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="add-asset-generate-pane">
      <div className="add-asset-generate-body">
        <section className="add-asset-generate-section">
          <h3>Start frame</h3>
          <p className="muted add-asset-generate-note">
            Last frame of the previous video clip on the timeline.
          </p>
          <div className="add-asset-generate-field add-asset-generate-frame-field">
            <div
              className="add-asset-generate-frame-preview"
              style={{ aspectRatio: projectAspectCss(aspectRatio) }}
            >
              {startFrameLoading ? (
                <p className="muted add-asset-generate-field-placeholder">
                  Loading start frame…
                </p>
              ) : startFrame?.previewUrl ? (
                <img
                  src={startFrame.previewUrl}
                  alt="Start frame from previous clip"
                  draggable={false}
                />
              ) : (
                <p className="muted add-asset-generate-field-placeholder">
                  No prior video clip — generation will start without a still.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="add-asset-generate-section">
          <h3>Audio</h3>
          {hasLyrics ? (
            <>
              <p className="muted add-asset-generate-note">
                Choose which part of the song to sync for this clip.
              </p>
              <div
                className="add-asset-generate-audio-toggle"
                role="group"
                aria-label="Audio source"
              >
                <button
                  type="button"
                  className={resolvedAudioMode === "vocals" ? "is-active" : ""}
                  onClick={() => setAudioMode("vocals")}
                  aria-pressed={resolvedAudioMode === "vocals"}
                >
                  Lyrics track
                </button>
                <button
                  type="button"
                  className={
                    resolvedAudioMode === "full_mix" ? "is-active" : ""
                  }
                  onClick={() => setAudioMode("full_mix")}
                  aria-pressed={resolvedAudioMode === "full_mix"}
                >
                  Full track
                </button>
              </div>
            </>
          ) : (
            <p className="muted add-asset-generate-note">
              {ADD_ASSET_NO_LYRICS_AUDIO_NOTE}
            </p>
          )}
        </section>

        {hasLyrics && resolvedAudioMode === "vocals" ? (
          <section className="add-asset-generate-section">
            <h3>Lyrics</h3>
            <p className="muted add-asset-generate-note">
              {formatTimeRange(songRange.startSec, songRange.endSec)} on the song
              timeline
            </p>
            <div
              className="add-asset-generate-callout"
              role="note"
              aria-label="Lyrics for this section"
            >
              <p className="add-asset-generate-lyrics-text">{lyricsText}</p>
            </div>
          </section>
        ) : null}

        <section className="add-asset-generate-section">
          <label
            className="add-asset-generate-prompt-label"
            htmlFor="add-asset-prompt"
          >
            <span>Prompt</span>
            <textarea
              id="add-asset-prompt"
              className="add-asset-generate-prompt"
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what happens in these 9 seconds…"
            />
          </label>
        </section>
      </div>

      <GenerateActions
        onRefresh={handleRefresh}
        onGenerate={handleGenerate}
        refreshDisabled={startFrameLoading}
        generateDisabled={startFrameLoading || !prompt.trim()}
      />
    </div>
  );
}
