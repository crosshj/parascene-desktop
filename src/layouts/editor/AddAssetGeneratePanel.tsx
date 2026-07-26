import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { LAB_A2V_PROMPT } from "../../lab/labPrompts";
import type {
  AddAssetDraft,
  LyricAlignment,
  TimelineClip,
} from "../../project/types";
import {
  PROJECT_ASPECT_OPTIONS,
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import {
  addAssetGenerationExpectedMs,
  addAssetGenerationProgress,
  resolveAddAssetAudioMode,
  type AddAssetAudioMode,
  type AddAssetContinuityMode,
  type AddAssetGenerationSession,
} from "./addAssetGenerate";
import { resolveLyricsForTimeRange, matchingLyricAlignment } from "./addAssetLyrics";
import {
  resolveAddAssetBridgeFrames,
  resolveAddAssetGenerationTiming,
  resolveAddAssetStartFrame,
  type BridgeFrames,
  type StartFramePreview,
} from "./addAssetStartFrame";
import {
  ADD_ASSET_MAX_DURATION_SEC,
  ADD_ASSET_MIN_DURATION_SEC,
  addAssetClipDurationSec,
  clampAddAssetDurationSec,
  withAddAssetDuration,
} from "./stagedClip";

export type StartAddAssetGenerationRequest = {
  clip: TimelineClip;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode;
  songRange: { startSec: number; endSec: number };
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
};

type AddAssetGeneratePanelProps = {
  clip: TimelineClip;
  aspectRatio: ProjectAspectRatio;
  session: AddAssetGenerationSession | null;
  timeline: readonly TimelineClip[];
  lyricAlignment: LyricAlignment | null;
  mainAudioCreationId: string | null;
  onStartGeneration: (request: StartAddAssetGenerationRequest) => void;
  /** Resize the placeholder on the timeline when duration changes. */
  onDurationChange?: (durationSec: number) => void;
  /** Persist prompt / mode choices on the placeholder clip. */
  onDraftChange?: (draft: AddAssetDraft) => void;
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

function draftFromClip(
  clip: TimelineClip,
  lyricsText: string,
): {
  prompt: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode | null;
} {
  const draft = clip.addAssetDraft;
  return {
    prompt:
      typeof draft?.prompt === "string" ? draft.prompt : LAB_A2V_PROMPT,
    audioMode:
      draft?.audioMode === "vocals" || draft?.audioMode === "full_mix"
        ? draft.audioMode
        : resolveAddAssetAudioMode(lyricsText),
    continuityMode:
      draft?.continuityMode === "first_last" ||
      draft?.continuityMode === "start_frame"
        ? draft.continuityMode
        : null,
  };
}

function draftsEqual(a: AddAssetDraft, b: AddAssetDraft | undefined): boolean {
  return (
    (a.prompt ?? "") === (b?.prompt ?? "") &&
    (a.audioMode ?? "") === (b?.audioMode ?? "") &&
    (a.continuityMode ?? "") === (b?.continuityMode ?? "") &&
    (a.provider ?? "") === (b?.provider ?? "") &&
    (a.methodId ?? "") === (b?.methodId ?? "")
  );
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
        `${clip.id}:${clip.startSec.toFixed(3)}:${clip.endSec.toFixed(3)}:${clip.assetId ?? ""}:${clip.inSec ?? 0}:${clip.outSec ?? ""}:${clip.framing ?? "fit"}:${clip.reverse ? 1 : 0}`,
    )
    .join("|");
}

function AddAssetGenerationProgressBar({
  startedAtMs,
  expectedMs,
}: {
  startedAtMs: number;
  expectedMs: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  const { percent, indeterminate } = addAssetGenerationProgress(
    nowMs - startedAtMs,
    expectedMs,
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

function FramePreview({
  aspectRatio,
  loading,
  loadingLabel,
  preview,
  emptyLabel,
  alt,
}: {
  aspectRatio: ProjectAspectRatio;
  loading: boolean;
  loadingLabel: string;
  preview: StartFramePreview | null;
  emptyLabel: string;
  alt: string;
}) {
  const aspect = PROJECT_ASPECT_OPTIONS.find((o) => o.id === aspectRatio);
  const w = aspect?.w ?? 16;
  const h = aspect?.h ?? 9;
  return (
    <div
      className={`add-asset-generate-frame-preview${loading ? " is-loading" : ""}`}
      style={
        {
          aspectRatio: projectAspectCss(aspectRatio),
          "--add-asset-frame-aspect": projectAspectCss(aspectRatio),
          "--add-asset-frame-w": String(w),
          "--add-asset-frame-h": String(h),
        } as CSSProperties
      }
      aria-busy={loading || undefined}
    >
      {loading ? (
        <p className="muted add-asset-generate-field-placeholder">
          {loadingLabel}
        </p>
      ) : preview?.previewUrl ? (
        <img src={preview.previewUrl} alt={alt} draggable={false} />
      ) : (
        <p className="muted add-asset-generate-field-placeholder">{emptyLabel}</p>
      )}
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
  onDurationChange,
  onDraftChange,
  onClearError,
}: AddAssetGeneratePanelProps) {
  const timelineKey = useMemo(() => timelineFingerprint(timeline), [timeline]);
  const [pullEpoch, setPullEpoch] = useState(0);
  const clipDurationSec = addAssetClipDurationSec(clip);
  const [durationDraft, setDurationDraft] = useState(String(clipDurationSec));
  const [prevClipDuration, setPrevClipDuration] = useState(clipDurationSec);
  if (clipDurationSec !== prevClipDuration) {
    setPrevClipDuration(clipDurationSec);
    setDurationDraft(String(clipDurationSec));
  }

  const { songRange, lyricsText } = useMemo(() => {
    const { songRange: range } = resolveAddAssetGenerationTiming(
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

  // Heal placeholders that somehow fall outside the allowed window.
  useEffect(() => {
    const raw = Number(clip.endSec) - Number(clip.startSec);
    if (!Number.isFinite(raw) || raw <= 0) return;
    const clamped = clampAddAssetDurationSec(raw);
    if (Math.abs(raw - clamped) < 0.05) return;
    onDurationChange?.(clamped);
  }, [clip.id, clip.startSec, clip.endSec, onDurationChange]);

  const commitDurationDraft = () => {
    const next = clampAddAssetDurationSec(Number(durationDraft));
    setDurationDraft(String(next));
    if (Math.abs(next - clipDurationSec) >= 0.05) {
      onDurationChange?.(next);
    }
  };

  const initial = draftFromClip(clip, lyricsText);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [audioMode, setAudioMode] = useState<AddAssetAudioMode>(
    initial.audioMode,
  );
  /** null = auto (prefer first+last when both frames exist). */
  const [continuityMode, setContinuityMode] =
    useState<AddAssetContinuityMode | null>(initial.continuityMode);
  const [loadedFrames, setLoadedFrames] = useState<{
    key: string;
    start: StartFramePreview | null;
    bridge: BridgeFrames | null;
  } | null>(null);
  const [prevLyricsText, setPrevLyricsText] = useState(lyricsText);
  if (lyricsText !== prevLyricsText) {
    setPrevLyricsText(lyricsText);
    // Keep prompt / modes; only refresh neighbor frames for the new window.
    setPullEpoch(0);
    setLoadedFrames(null);
  }

  const framesKey = `${timelineKey}:${clip.id}:${aspectRatio}:frame-v3:${pullEpoch}`;
  const activeSession = session?.clipId === clip.id ? session : null;
  const phase: PanelPhase = activeSession?.phase ?? "form";
  const framesReady = loadedFrames?.key === framesKey;
  const startFrame = framesReady ? loadedFrames.start : null;
  const bridge = framesReady ? loadedFrames.bridge : null;
  const bridgeAvailable = Boolean(bridge);
  const framesLoading = phase === "form" && !framesReady;

  const hasLyrics = Boolean(lyricsText.trim());
  const resolvedAudioMode = hasLyrics ? audioMode : "full_mix";
  const resolvedContinuityMode: AddAssetContinuityMode = bridgeAvailable
    ? (continuityMode ?? "first_last")
    : "start_frame";

  // Persist form choices on the placeholder so they survive clip switches.
  useEffect(() => {
    const next: AddAssetDraft = {
      prompt,
      audioMode,
      continuityMode: continuityMode ?? undefined,
      provider: clip.addAssetDraft?.provider,
      methodId: clip.addAssetDraft?.methodId,
    };
    if (draftsEqual(next, clip.addAssetDraft)) return;
    onDraftChange?.(next);
  }, [prompt, audioMode, continuityMode, clip.addAssetDraft, onDraftChange]);

  useEffect(() => {
    if (phase !== "form") return;
    let cancelled = false;
    void (async () => {
      const [start, resolvedBridge] = await Promise.all([
        resolveAddAssetStartFrame(timeline, clip, aspectRatio),
        resolveAddAssetBridgeFrames(timeline, clip, aspectRatio),
      ]);
      if (cancelled) return;
      setLoadedFrames({
        key: framesKey,
        start,
        bridge: resolvedBridge,
      });
      // Bridge gone → can't keep first_last; otherwise keep draft/auto choice.
      if (!resolvedBridge) {
        setContinuityMode((prev) =>
          prev === "first_last" ? "start_frame" : prev,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
    // framesKey covers clip geometry / neighbors; omit clip/timeline objects so
    // drafting the prompt does not re-extract frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [framesKey, phase, aspectRatio]);

  const handleRefresh = () => {
    if (phase !== "form" || framesLoading) return;
    setLoadedFrames(null);
    setPullEpoch((epoch) => epoch + 1);
  };

  const handleGenerate = () => {
    if (phase !== "form" || !prompt.trim()) return;
    const useFirstLast = resolvedContinuityMode === "first_last";
    if (useFirstLast) {
      if (!bridge?.first.framePath?.trim() || !bridge.last.framePath?.trim()) {
        return;
      }
    } else if (!startFrame?.framePath?.trim()) {
      return;
    }

    void (async () => {
      const timing = resolveAddAssetGenerationTiming(
        timeline,
        clip,
        mainAudioCreationId,
        lyricAlignment,
      );
      if (useFirstLast) {
        const freshBridge = await resolveAddAssetBridgeFrames(
          timeline,
          clip,
          aspectRatio,
        );
        if (
          !freshBridge?.first.framePath?.trim() ||
          !freshBridge.last.framePath?.trim()
        ) {
          return;
        }
        onStartGeneration({
          clip: withAddAssetDuration(clip, timing.durationSec),
          prompt,
          lyricsText,
          audioMode: resolvedAudioMode,
          continuityMode: "first_last",
          songRange: timing.songRange,
          startFrame: freshBridge.first,
          endFrame: freshBridge.last,
        });
        return;
      }

      const freshStart = await resolveAddAssetStartFrame(
        timeline,
        clip,
        aspectRatio,
      );
      if (!freshStart.framePath?.trim()) return;
      onStartGeneration({
        clip: withAddAssetDuration(clip, timing.durationSec),
        prompt,
        lyricsText,
        audioMode: resolvedAudioMode,
        continuityMode: "start_frame",
        songRange: timing.songRange,
        startFrame: freshStart,
        endFrame: null,
      });
    })();
  };

  const canGenerate =
    phase === "form" &&
    Boolean(prompt.trim()) &&
    !framesLoading &&
    (resolvedContinuityMode === "first_last"
      ? Boolean(
          bridge?.first.framePath?.trim() && bridge.last.framePath?.trim(),
        )
      : Boolean(startFrame?.framePath?.trim()));

  if (phase === "running" && activeSession) {
    return (
      <div
        className="add-asset-generate-pane"
        aria-busy
        aria-label="Generating video"
      >
        <div className="add-asset-generate-body">
          <AddAssetGenerationProgressBar
            startedAtMs={activeSession.startedAtMs}
            expectedMs={
              activeSession.expectedMs ??
              addAssetGenerationExpectedMs(clipDurationSec)
            }
          />
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

  const showFirstLast = resolvedContinuityMode === "first_last";
  const firstPreview = showFirstLast ? bridge?.first ?? null : startFrame;
  const lastPreview = showFirstLast ? bridge?.last ?? null : null;

  return (
    <div className="add-asset-generate-pane">
      <div className="add-asset-generate-body">
        {bridgeAvailable ? (
          <section className="add-asset-generate-section">
            <h3>Continuity</h3>
            <div
              className="add-asset-generate-audio-toggle"
              role="group"
              aria-label="Continuity mode"
            >
              <button
                type="button"
                className={
                  resolvedContinuityMode === "first_last" ? "is-active" : ""
                }
                onClick={() => setContinuityMode("first_last")}
                aria-pressed={resolvedContinuityMode === "first_last"}
              >
                First + last frame
              </button>
              <button
                type="button"
                className={
                  resolvedContinuityMode === "start_frame" ? "is-active" : ""
                }
                onClick={() => setContinuityMode("start_frame")}
                aria-pressed={resolvedContinuityMode === "start_frame"}
              >
                Start frame
              </button>
            </div>
          </section>
        ) : null}

        <section className="add-asset-generate-section">
          <h3>{showFirstLast ? "First & last frames" : "Start frame"}</h3>
          {showFirstLast ? (
            <div className="add-asset-generate-frame-pair">
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">First</span>
                <FramePreview
                  aspectRatio={aspectRatio}
                  loading={framesLoading}
                  loadingLabel="Loading first frame…"
                  preview={firstPreview}
                  emptyLabel="No previous clip."
                  alt="First frame from previous clip"
                />
              </div>
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">Last</span>
                <FramePreview
                  aspectRatio={aspectRatio}
                  loading={framesLoading}
                  loadingLabel="Loading last frame…"
                  preview={lastPreview}
                  emptyLabel="No next clip."
                  alt="Last frame from next clip"
                />
              </div>
            </div>
          ) : (
            <div className="add-asset-generate-field add-asset-generate-frame-field">
              <FramePreview
                aspectRatio={aspectRatio}
                loading={framesLoading}
                loadingLabel="Loading start frame…"
                preview={startFrame}
                emptyLabel="No prior video clip — generation will start without a still."
                alt="Start frame from previous clip"
              />
            </div>
          )}
        </section>

        <section className="add-asset-generate-section">
          <h3>Duration</h3>
          <label className="add-asset-generate-field">
            <span>Seconds</span>
            <input
              type="number"
              min={ADD_ASSET_MIN_DURATION_SEC}
              max={ADD_ASSET_MAX_DURATION_SEC}
              step={0.5}
              value={durationDraft}
              disabled={phase !== "form"}
              onChange={(event) => setDurationDraft(event.target.value)}
              onBlur={commitDurationDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitDurationDraft();
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
        </section>

        {!showFirstLast && hasLyrics ? (
          <section className="add-asset-generate-section">
            <h3>Audio</h3>
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
          </section>
        ) : null}

        {!showFirstLast && hasLyrics && resolvedAudioMode === "vocals" ? (
          <section className="add-asset-generate-section">
            <h3>Lyrics</h3>
            <div
              className="add-asset-generate-callout"
              role="note"
              aria-label={`Lyrics for ${formatTimeRange(songRange.startSec, songRange.endSec)}`}
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
              placeholder={`Describe what happens in these ${clipDurationSec.toFixed(1)} seconds…`}
            />
          </label>
        </section>
      </div>

      <GenerateActions
        onRefresh={handleRefresh}
        onGenerate={handleGenerate}
        refreshDisabled={framesLoading}
        generateDisabled={!canGenerate}
      />
    </div>
  );
}
