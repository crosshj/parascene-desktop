import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LAB_A2V_PROMPT } from "../../lab/labPrompts";
import { getCreations } from "../../library/catalogClient";
import { creationPreviewUrl } from "../../library/previewUrl";
import type {
  AddAssetDraft,
  LyricAlignment,
  ProjectAsset,
  TimelineClip,
} from "../../project/types";
import {
  PROJECT_ASPECT_OPTIONS,
  projectAspectCss,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import {
  ADD_ASSET_IMAGES_NONE_AUDIO_NOTE,
  ADD_ASSET_WAN_AUDIO_NOTE,
  addAssetGenerationExpectedMs,
  addAssetGenerationProgress,
  resolveAddAssetAudioMode,
  type AddAssetAudioMode,
  type AddAssetBlueModel,
  type AddAssetContinuityMode,
  type AddAssetGenerationSession,
  type RunAddAssetGenerationOpts,
} from "./addAssetGenerate";
import { resolveLyricsForTimeRange, matchingLyricAlignment } from "./addAssetLyrics";
import {
  resolveAddAssetBridgeFrames,
  resolveAddAssetGenerationTiming,
  resolveStartFrameForAddAsset,
  framePathBasename,
  startFrameIsReady,
  type BridgeFrames,
  type StartFramePreview,
} from "./addAssetStartFrame";
import {
  ADD_ASSET_MAX_DURATION_SEC,
  ADD_ASSET_MIN_DURATION_SEC,
  addAssetClipDurationSec,
  clampAddAssetDurationSec,
  normalizeFraming,
  withAddAssetDuration,
  type StagedClipFraming,
} from "./stagedClip";
import { isDownloadRetryableError } from "./addAssetReplicateGenerate";
import { recordUiOpTrace } from "./uiOpTrace";
import {
  nearestAllowedDuration,
  durationConstraintFromField,
  mapReplicateVideoFields,
  validateReplicateRun,
  type ReplicateVideoContinuity,
} from "./replicateRunConstraints";
import {
  loadReplicateVideoFillModels,
  pickCompatibleReplicateModel,
  replicateModelOptionDisabledReason,
  type ReplicateVideoModelOption,
} from "./replicateVideoModels";
import { resolveMotionReferenceVideoPath } from "./addAssetReplicateGenerate";
import {
  discoverReplicateTweakFields,
  hasAnyReplicateTweaks,
  normalizeReplicateTweaks,
  replicateTweaksEqual,
  type ReplicateTweakFields,
  type ReplicateVideoTweaks,
} from "./replicateVideoTweaks";

export type StartAddAssetGenerationRequest = {
  clip: TimelineClip;
  prompt: string;
  lyricsText: string;
  audioMode: AddAssetAudioMode;
  continuityMode: AddAssetContinuityMode;
  /** Parascene Blue model when not generating via Replicate. */
  blueModel?: AddAssetBlueModel;
  songRange: { startSec: number; endSec: number };
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
  /** Present when generating via Replicate timeline fill. */
  replicate?: RunAddAssetGenerationOpts["replicate"];
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
  /** Dismiss error and return to the form (edit / full regenerate). */
  onClearError?: () => void;
  /** Retry download for a prediction that already succeeded on Replicate. */
  onRetryDownload?: () => void;
  /** Project image assets available as an explicit start frame. */
  imageAssets?: ProjectAsset[];
  /** Return to provider selection for this existing placeholder. */
  onBackToProvider?: () => void;
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
  blueModel: AddAssetBlueModel | null;
  replicateModel: string | null;
  useNearestDuration: boolean;
  replicateTweaks: ReplicateVideoTweaks | null;
} {
  const draft = clip.addAssetDraft;
  const continuity =
    draft?.continuityMode === "first_last" ||
    draft?.continuityMode === "start_frame" ||
    draft?.continuityMode === "motion_match" ||
    draft?.continuityMode === "none"
      ? draft.continuityMode
      : null;
  const blueModel =
    draft?.blueModel === "wan" || draft?.blueModel === "ltx"
      ? draft.blueModel
      : continuity === "first_last"
        ? "wan"
        : continuity === "start_frame" || continuity === "none"
          ? "ltx"
          : null;
  const audioMode: AddAssetAudioMode =
    draft?.audioMode === "vocals" ||
    draft?.audioMode === "full_mix" ||
    draft?.audioMode === "none"
      ? draft.audioMode
      : blueModel === "wan" || continuity === "none"
        ? "none"
        : resolveAddAssetAudioMode(lyricsText);
  return {
    prompt:
      typeof draft?.prompt === "string" ? draft.prompt : LAB_A2V_PROMPT,
    audioMode,
    continuityMode: continuity,
    blueModel,
    replicateModel:
      typeof draft?.replicateModel === "string" && draft.replicateModel.trim()
        ? draft.replicateModel.trim()
        : null,
    useNearestDuration: Boolean(draft?.useNearestDuration),
    replicateTweaks: draft?.replicateTweaks ?? null,
  };
}

function draftsEqual(a: AddAssetDraft, b: AddAssetDraft | undefined): boolean {
  return (
    (a.prompt ?? "") === (b?.prompt ?? "") &&
    (a.audioMode ?? "") === (b?.audioMode ?? "") &&
    (a.continuityMode ?? "") === (b?.continuityMode ?? "") &&
    (a.blueModel ?? "") === (b?.blueModel ?? "") &&
    (a.provider ?? "") === (b?.provider ?? "") &&
    (a.methodId ?? "") === (b?.methodId ?? "") &&
    (a.replicateModel ?? "") === (b?.replicateModel ?? "") &&
    Boolean(a.useNearestDuration) === Boolean(b?.useNearestDuration) &&
    (a.lastError ?? "") === (b?.lastError ?? "") &&
    (a.replicatePredictionId ?? "") === (b?.replicatePredictionId ?? "") &&
    replicateTweaksEqual(a.replicateTweaks, b?.replicateTweaks) &&
    (a.startFrameAssetId ?? "") === (b?.startFrameAssetId ?? "") &&
    normalizeFraming(a.startFrameFraming) ===
      normalizeFraming(b?.startFrameFraming)
  );
}

function isReplicateTimelineFill(clip: TimelineClip): boolean {
  const draft = clip.addAssetDraft;
  return (
    draft?.provider === "replicate" &&
    (draft.methodId === "replicate_timeline_fill" || !draft.methodId)
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
  const hasUsableFrame = startFrameIsReady(preview);
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
      ) : hasUsableFrame && preview?.previewUrl ? (
        <img src={preview.previewUrl} alt={alt} draggable={false} />
      ) : preview?.previewUrl ? (
        <>
          <img src={preview.previewUrl} alt={alt} draggable={false} />
          <p className="muted add-asset-generate-field-placeholder">
            Preview only — no local still file to send as start image.
          </p>
        </>
      ) : (
        <p className="muted add-asset-generate-field-placeholder">{emptyLabel}</p>
      )}
    </div>
  );
}

function StartFrameAssetPicker({
  assets,
  selectedId,
  previewsById,
  disabled,
  onSelect,
  onClear,
}: {
  assets: ProjectAsset[];
  selectedId: string | null;
  previewsById: Record<string, string | null>;
  disabled?: boolean;
  onSelect: (assetId: string) => void;
  onClear: () => void;
}) {
  if (assets.length === 0) return null;
  return (
    <div className="add-asset-start-frame-assets">
      <div className="add-asset-start-frame-assets-header">
        <span className="muted">Or choose from assets</span>
        {selectedId ? (
          <button
            type="button"
            className="btn ghost"
            disabled={disabled}
            onClick={onClear}
          >
            Use timeline clip
          </button>
        ) : null}
      </div>
      <div
        className="add-asset-start-frame-assets-grid"
        role="listbox"
        aria-label="Project image assets"
      >
        {assets.map((asset) => {
          const selected = asset.id === selectedId;
          const thumb = previewsById[asset.id];
          return (
            <button
              key={asset.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={
                selected
                  ? "add-asset-start-frame-asset is-selected"
                  : "add-asset-start-frame-asset"
              }
              title={asset.name}
              disabled={disabled}
              onClick={() => onSelect(asset.id)}
            >
              {thumb ? (
                <img src={thumb} alt="" draggable={false} />
              ) : (
                <span className="muted">Image</span>
              )}
            </button>
          );
        })}
      </div>
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
  onRetryDownload,
  imageAssets = [],
  onBackToProvider,
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
  const isReplicate = isReplicateTimelineFill(clip);
  const startFrameAssetId =
    clip.addAssetDraft?.startFrameAssetId?.trim() || null;
  const startFrameFraming = normalizeFraming(
    clip.addAssetDraft?.startFrameFraming,
  );
  const [prompt, setPrompt] = useState(initial.prompt);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [audioMode, setAudioMode] = useState<AddAssetAudioMode>(
    initial.audioMode,
  );
  /** null = auto (prefer first+last when both frames exist). */
  const [continuityMode, setContinuityMode] =
    useState<AddAssetContinuityMode | null>(initial.continuityMode);
  /** null = auto from continuity / bridge (WAN when bridged, else LTX). */
  const [blueModel, setBlueModel] = useState<AddAssetBlueModel | null>(
    initial.blueModel,
  );
  const [replicateModelId, setReplicateModelId] = useState<string | null>(
    initial.replicateModel,
  );
  const [useNearestDuration, setUseNearestDuration] = useState(
    initial.useNearestDuration,
  );
  const [replicateTweaks, setReplicateTweaks] = useState<ReplicateVideoTweaks>(
    () => initial.replicateTweaks ?? {},
  );
  const [replicateModels, setReplicateModels] = useState<
    ReplicateVideoModelOption[] | null
  >(null);
  const [replicateModelsError, setReplicateModelsError] = useState<string | null>(
    null,
  );
  const [motionVideoPath, setMotionVideoPath] = useState<string | null>(null);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string | null>>(
    {},
  );

  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);
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

  const framesKey = `${timelineKey}:${clip.id}:${aspectRatio}:frame-v5:${pullEpoch}:${startFrameAssetId ?? ""}:${startFrameFraming}`;
  const activeSession = session?.clipId === clip.id ? session : null;
  const draftError = clip.addAssetDraft?.lastError?.trim() || null;
  const phase: PanelPhase =
    activeSession?.phase ?? (draftError ? "error" : "form");
  const framesReady = loadedFrames?.key === framesKey;
  const startFrame = framesReady ? loadedFrames.start : null;
  const bridge = framesReady ? loadedFrames.bridge : null;
  const bridgeAvailable = Boolean(bridge);
  const framesLoading = phase === "form" && !framesReady;

  const hasLyrics = Boolean(lyricsText.trim());
  const hasMainAudio = Boolean(mainAudioCreationId?.trim());

  const resolvedBlueModel: AddAssetBlueModel = (() => {
    if (isReplicate) return "ltx";
    if (blueModel === "wan" || blueModel === "ltx") return blueModel;
    if (continuityMode === "first_last") return "wan";
    if (continuityMode === "start_frame" || continuityMode === "none") {
      return "ltx";
    }
    return bridgeAvailable ? "wan" : "ltx";
  })();

  const resolvedContinuityMode: AddAssetContinuityMode = (() => {
    if (isReplicate) {
      if (continuityMode === "motion_match") return "motion_match";
      if (bridgeAvailable) return continuityMode ?? "first_last";
      if (continuityMode === "first_last") return "start_frame";
      if (continuityMode === "none") return "start_frame";
      return continuityMode ?? "start_frame";
    }
    // Images: None = text→video (WAN or LTX).
    if (continuityMode === "none") return "none";
    // LTX is start-frame only (or none, handled above).
    if (resolvedBlueModel === "ltx") return "start_frame";
    // WAN: first+last when bridged, else start frame.
    if (continuityMode === "first_last" && bridgeAvailable) return "first_last";
    return "start_frame";
  })();

  const sourceAudioLocked =
    !isReplicate &&
    (resolvedBlueModel === "wan" ||
      resolvedContinuityMode === "none" ||
      !hasMainAudio);

  const resolvedAudioMode: AddAssetAudioMode = (() => {
    if (isReplicate) {
      return hasLyrics ? (audioMode === "full_mix" ? "full_mix" : "vocals") : "full_mix";
    }
    if (sourceAudioLocked) return "none";
    if (audioMode === "none") return "none";
    if (!hasLyrics) return "full_mix";
    return audioMode === "full_mix" ? "full_mix" : "vocals";
  })();

  const selectBlueModel = (next: AddAssetBlueModel) => {
    setBlueModel(next);
    if (next === "wan") {
      setAudioMode("none");
      return;
    }
    // LTX cannot use first+last; keep Images: None if selected.
    if (continuityMode === "first_last") {
      setContinuityMode("start_frame");
    }
  };

  const selectImagesMode = (next: AddAssetContinuityMode) => {
    if (next === "none") {
      setContinuityMode("none");
      setAudioMode("none");
      return;
    }
    if (next === "first_last") {
      setBlueModel("wan");
      setAudioMode("none");
      setContinuityMode("first_last");
      return;
    }
    setContinuityMode("start_frame");
  };

  const selectSourceAudio = (next: AddAssetAudioMode) => {
    if (sourceAudioLocked) return;
    setAudioMode(next);
  };

  // Keep draft audio locked to None for WAN, Images: None, or when no main audio.
  useEffect(() => {
    if (!sourceAudioLocked) return;
    if (audioMode !== "none") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lock source audio to none
      setAudioMode("none");
    }
  }, [sourceAudioLocked, audioMode]);

  // Load enabled Replicate video models once for this panel.
  useEffect(() => {
    if (!isReplicate || phase !== "form") return;
    let cancelled = false;
    void (async () => {
      try {
        const models = await loadReplicateVideoFillModels();
        if (cancelled) return;
        setReplicateModels(models);
        setReplicateModelsError(null);
      } catch (error) {
        if (cancelled) return;
        setReplicateModels([]);
        setReplicateModelsError(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReplicate, phase, clip.id]);

  // Resolve motion-reference video path when needed.
  useEffect(() => {
    if (!isReplicate || resolvedContinuityMode !== "motion_match") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear when mode leaves motion match
      setMotionVideoPath(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const path = await resolveMotionReferenceVideoPath(timeline, clip);
      if (!cancelled) setMotionVideoPath(path);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint covers geometry
  }, [isReplicate, resolvedContinuityMode, framesKey]);

  const hasStartFrame = startFrameIsReady(
    resolvedContinuityMode === "first_last" ? bridge?.first : startFrame,
  );
  const hasEndFrame = Boolean(bridge?.last.framePath?.trim());
  const hasImageInput = hasStartFrame;

  const selectedReplicateModel = useMemo(() => {
    if (!isReplicate || !replicateModels) return null;
    return (
      pickCompatibleReplicateModel({
        models: replicateModels,
        continuity: resolvedContinuityMode as ReplicateVideoContinuity,
        durationSec: clipDurationSec,
        aspectRatio,
        hasImageInput,
        preferredId: replicateModelId,
      }) ??
      replicateModels.find((m) => m.id === replicateModelId) ??
      null
    );
  }, [
    isReplicate,
    replicateModels,
    resolvedContinuityMode,
    clipDurationSec,
    aspectRatio,
    hasImageInput,
    replicateModelId,
  ]);

  const tweakFields: ReplicateTweakFields | null = useMemo(() => {
    if (!selectedReplicateModel) return null;
    return discoverReplicateTweakFields(selectedReplicateModel.inputs);
  }, [selectedReplicateModel]);

  const normalizedTweaks = useMemo(() => {
    if (!tweakFields) return {};
    return normalizeReplicateTweaks(tweakFields, replicateTweaks);
  }, [tweakFields, replicateTweaks]);

  // Keep tweak values valid when the model changes.
  useEffect(() => {
    if (!tweakFields) return;
    const next = normalizeReplicateTweaks(tweakFields, replicateTweaks);
    if (!replicateTweaksEqual(next, replicateTweaks)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp tweaks to new model schema
      setReplicateTweaks(next);
    }
    // Only re-normalize when the selected model (fields) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [tweakFields]);

  // Keep selection on a compatible model when duration/aspect/continuity change.
  useEffect(() => {
    if (!isReplicate || !replicateModels || phase !== "form") return;
    const next = pickCompatibleReplicateModel({
      models: replicateModels,
      continuity: resolvedContinuityMode as ReplicateVideoContinuity,
      durationSec: clipDurationSec,
      aspectRatio,
      hasImageInput,
      preferredId: replicateModelId,
    });
    if (next && next.id !== replicateModelId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- snap to compatible model
      setReplicateModelId(next.id);
      setUseNearestDuration(false);
    }
  }, [
    isReplicate,
    replicateModels,
    resolvedContinuityMode,
    clipDurationSec,
    aspectRatio,
    hasImageInput,
    replicateModelId,
    phase,
  ]);

  const replicateValidation = useMemo(() => {
    if (!isReplicate || !selectedReplicateModel) return null;
    return validateReplicateRun({
      inputs: selectedReplicateModel.inputs,
      continuity: resolvedContinuityMode as ReplicateVideoContinuity,
      durationSec: clipDurationSec,
      aspectRatio,
      useNearestDuration,
      hasStartFrame,
      hasEndFrame:
        resolvedContinuityMode === "first_last" ? hasEndFrame : false,
      hasCharacterImage: hasStartFrame,
      hasMotionVideo: Boolean(motionVideoPath),
      prompt,
    });
  }, [
    isReplicate,
    selectedReplicateModel,
    resolvedContinuityMode,
    clipDurationSec,
    aspectRatio,
    useNearestDuration,
    hasStartFrame,
    hasEndFrame,
    motionVideoPath,
    prompt,
  ]);

  // Load thumbnails for the start-frame asset picker.
  useEffect(() => {
    if (isReplicate || imageAssets.length === 0) return;
    let cancelled = false;
    const ids = imageAssets.map((asset) => asset.id);
    void (async () => {
      const rows = await getCreations(ids);
      if (cancelled) return;
      const next: Record<string, string | null> = {};
      for (const row of rows) {
        next[row.id] = creationPreviewUrl(row);
      }
      setAssetPreviews(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [imageAssets, isReplicate]);

  // Persist form choices on the placeholder so they survive clip switches.
  useEffect(() => {
    const next: AddAssetDraft = {
      prompt,
      audioMode: resolvedAudioMode,
      continuityMode: resolvedContinuityMode,
      blueModel: isReplicate ? undefined : resolvedBlueModel,
      provider: clip.addAssetDraft?.provider,
      methodId: clip.addAssetDraft?.methodId,
      replicateModel: replicateModelId ?? undefined,
      useNearestDuration: useNearestDuration || undefined,
      lastError: clip.addAssetDraft?.lastError,
      replicatePredictionId: clip.addAssetDraft?.replicatePredictionId,
      replicateTweaks: isReplicate ? normalizedTweaks : undefined,
      startFrameAssetId: startFrameAssetId ?? undefined,
      startFrameFraming:
        startFrameFraming === "fit" ? undefined : startFrameFraming,
    };
    if (draftsEqual(next, clip.addAssetDraft)) return;
    onDraftChange?.(next);
  }, [
    prompt,
    resolvedAudioMode,
    resolvedContinuityMode,
    resolvedBlueModel,
    replicateModelId,
    useNearestDuration,
    normalizedTweaks,
    isReplicate,
    clip.addAssetDraft,
    startFrameAssetId,
    startFrameFraming,
    onDraftChange,
  ]);

  useEffect(() => {
    if (phase !== "form") return;
    let cancelled = false;
    void (async () => {
      const frameOpts = {
        startFrameAssetId,
        framing: startFrameFraming,
      };
      const [start, resolvedBridge] = await Promise.all([
        resolveStartFrameForAddAsset(timeline, clip, aspectRatio, frameOpts),
        resolveAddAssetBridgeFrames(timeline, clip, aspectRatio, {
          framing: startFrameFraming,
        }),
      ]);
      if (cancelled) return;
      setLoadedFrames({
        key: framesKey,
        start,
        bridge: resolvedBridge,
      });
      // Bridge gone → can't keep first_last; WAN still works with start frame.
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

  const setStartFrameAssetId = (assetId: string | null) => {
    onDraftChange?.({
      ...(clip.addAssetDraft ?? {}),
      startFrameAssetId: assetId ?? undefined,
    });
    setLoadedFrames(null);
    setPullEpoch((epoch) => epoch + 1);
  };

  const setStartFrameFraming = (framing: StagedClipFraming) => {
    onDraftChange?.({
      ...(clip.addAssetDraft ?? {}),
      startFrameFraming: framing === "fit" ? undefined : framing,
    });
    setLoadedFrames(null);
    setPullEpoch((epoch) => epoch + 1);
  };

  const handleGenerate = () => {
    if (phase !== "form" || !prompt.trim()) return;

    const abortGenerate = (reason: string, message: string) => {
      recordUiOpTrace({
        type: "add_asset_generate_abort",
        clipId: clip.id,
        kind: isReplicate ? "replicate" : "blue",
        reason: reason.slice(0, 200),
      });
      onDraftChange?.({
        ...(clip.addAssetDraft ?? {}),
        lastError: message,
      });
    };

    void (async () => {
      const timing = resolveAddAssetGenerationTiming(
        timeline,
        clip,
        mainAudioCreationId,
        lyricAlignment,
      );
      const clipWithDuration = withAddAssetDuration(clip, timing.durationSec);

      if (isReplicate) {
        if (!selectedReplicateModel || !replicateValidation?.ok) {
          abortGenerate(
            "validation_blocked",
            replicateValidation?.blockers[0] ??
              "Replicate run is not ready — check model and start frame.",
          );
          return;
        }
        // Defense in depth — identical check before any network.
        const recheck = validateReplicateRun({
          inputs: selectedReplicateModel.inputs,
          continuity: resolvedContinuityMode as ReplicateVideoContinuity,
          durationSec: timing.durationSec,
          aspectRatio,
          useNearestDuration,
          hasStartFrame,
          hasEndFrame:
            resolvedContinuityMode === "first_last" ? hasEndFrame : false,
          hasCharacterImage: hasStartFrame,
          hasMotionVideo: Boolean(motionVideoPath),
          prompt,
        });
        if (!recheck.ok) {
          abortGenerate(
            "recheck_blocked",
            recheck.blockers[0] ?? "Replicate run is not valid.",
          );
          return;
        }

        const freshStart = await resolveStartFrameForAddAsset(
          timeline,
          clip,
          aspectRatio,
          { startFrameAssetId, framing: startFrameFraming },
        );
        let endFrame: StartFramePreview | null = null;
        if (resolvedContinuityMode === "first_last") {
          const freshBridge = await resolveAddAssetBridgeFrames(
            timeline,
            clip,
            aspectRatio,
            { framing: startFrameFraming },
          );
          if (
            !freshBridge?.first.framePath?.trim() ||
            !freshBridge.last.framePath?.trim()
          ) {
            abortGenerate(
              "missing_bridge_frames",
              "Could not resolve local first/last frame stills. Place image or video clips on both sides, ensure they are downloaded, then Refresh.",
            );
            return;
          }
          endFrame = freshBridge.last;
          recordUiOpTrace({
            type: "add_asset_generate_start",
            clipId: clip.id,
            kind: "first_last",
            ids: selectedReplicateModel.id,
            reason: `first=${framePathBasename(freshBridge.first.framePath)} last=${framePathBasename(freshBridge.last.framePath)}`,
          });
          onStartGeneration({
            clip: clipWithDuration,
            prompt,
            lyricsText,
            audioMode: resolvedAudioMode,
            continuityMode: "first_last",
            songRange: timing.songRange,
            startFrame: freshBridge.first,
            endFrame,
            replicate: {
              owner: selectedReplicateModel.owner,
              name: selectedReplicateModel.name,
              inputs: selectedReplicateModel.inputs,
              useNearestDuration,
              motionVideoPath,
              characterFrame: freshBridge.first,
              tweaks: normalizedTweaks,
            },
          });
          return;
        }

        if (resolvedContinuityMode === "motion_match") {
          if (!freshStart.framePath?.trim() || !motionVideoPath) {
            abortGenerate(
              "missing_motion_inputs",
              "Motion match needs a character still and a previous video clip on the timeline.",
            );
            return;
          }
          recordUiOpTrace({
            type: "add_asset_generate_start",
            clipId: clip.id,
            kind: "motion_match",
            ids: selectedReplicateModel.id,
            reason: `still=${framePathBasename(freshStart.framePath)}`,
          });
          onStartGeneration({
            clip: clipWithDuration,
            prompt,
            lyricsText,
            audioMode: resolvedAudioMode,
            continuityMode: "motion_match",
            songRange: timing.songRange,
            startFrame: freshStart,
            endFrame: null,
            replicate: {
              owner: selectedReplicateModel.owner,
              name: selectedReplicateModel.name,
              inputs: selectedReplicateModel.inputs,
              useNearestDuration,
              motionVideoPath,
              characterFrame: freshStart,
              tweaks: normalizedTweaks,
            },
          });
          return;
        }

        if (!startFrameIsReady(freshStart)) {
          abortGenerate(
            "missing_start_frame",
            startFrameAssetId
              ? "Could not resolve the selected image on Parascene. Sync the asset, then Refresh."
              : "Could not resolve a local start-frame still from the previous clip. Download the clip, use an image or video prior, then Refresh.",
          );
          return;
        }
        recordUiOpTrace({
          type: "add_asset_generate_start",
          clipId: clip.id,
          kind: "start_frame",
          ids: selectedReplicateModel.id,
          reason: `start=${framePathBasename(freshStart.framePath)}`,
        });
        onStartGeneration({
          clip: clipWithDuration,
          prompt,
          lyricsText,
          audioMode: resolvedAudioMode,
          continuityMode: "start_frame",
          songRange: timing.songRange,
          startFrame: freshStart,
          endFrame: null,
          replicate: {
            owner: selectedReplicateModel.owner,
            name: selectedReplicateModel.name,
            inputs: selectedReplicateModel.inputs,
            useNearestDuration,
            motionVideoPath: null,
            characterFrame: freshStart,
            tweaks: normalizedTweaks,
          },
        });
        return;
      }

      const useFirstLast = resolvedContinuityMode === "first_last";
      if (resolvedContinuityMode === "none") {
        recordUiOpTrace({
          type: "add_asset_generate_start",
          clipId: clip.id,
          kind: "none",
          ids: resolvedBlueModel,
          reason: "text2video",
        });
        onStartGeneration({
          clip: clipWithDuration,
          prompt,
          lyricsText,
          audioMode: "none",
          continuityMode: "none",
          blueModel: resolvedBlueModel,
          songRange: timing.songRange,
          startFrame: {
            previewUrl: null,
            note: "",
            framePath: null,
            frameTimeSec: null,
          },
          endFrame: null,
        });
        return;
      }
      if (useFirstLast) {
        const freshBridge = await resolveAddAssetBridgeFrames(
          timeline,
          clip,
          aspectRatio,
          { framing: startFrameFraming },
        );
        if (
          !freshBridge?.first.framePath?.trim() ||
          !freshBridge.last.framePath?.trim()
        ) {
          abortGenerate(
            "missing_bridge_frames",
            "Could not resolve local first/last frame stills for generation.",
          );
          return;
        }
        onStartGeneration({
          clip: clipWithDuration,
          prompt,
          lyricsText,
          audioMode: resolvedAudioMode,
          continuityMode: "first_last",
          blueModel: "wan",
          songRange: timing.songRange,
          startFrame: freshBridge.first,
          endFrame: freshBridge.last,
        });
        return;
      }

      const freshStart = await resolveStartFrameForAddAsset(
        timeline,
        clip,
        aspectRatio,
        { startFrameAssetId, framing: startFrameFraming },
      );
      if (!startFrameIsReady(freshStart)) {
        abortGenerate(
          "missing_start_frame",
          startFrameAssetId
            ? "Could not resolve the selected image on Parascene. Sync the asset, then Refresh."
            : "Could not resolve a local start-frame still from the previous clip.",
        );
        return;
      }
      onStartGeneration({
        clip: clipWithDuration,
        prompt,
        lyricsText,
        audioMode: resolvedAudioMode,
        continuityMode: "start_frame",
        blueModel: resolvedBlueModel,
        songRange: timing.songRange,
        startFrame: freshStart,
        endFrame: null,
      });
    })();
  };

  const canGenerateBlue =
    phase === "form" &&
    Boolean(prompt.trim()) &&
    (resolvedContinuityMode === "none" ||
      (!framesLoading &&
        (resolvedContinuityMode === "first_last"
          ? Boolean(
              bridge?.first.framePath?.trim() && bridge.last.framePath?.trim(),
            )
          : startFrameIsReady(startFrame)))) &&
    (resolvedAudioMode === "none" || hasMainAudio);

  const canGenerate =
    isReplicate
      ? phase === "form" &&
        !framesLoading &&
        Boolean(selectedReplicateModel) &&
        Boolean(replicateValidation?.ok)
      : canGenerateBlue;

  const durationBlocker = replicateValidation?.blockers.find((b) =>
    b.includes("gap is"),
  );
  const nearestDuration =
    isReplicate && selectedReplicateModel
      ? (() => {
          const map = mapReplicateVideoFields(selectedReplicateModel.inputs);
          const field = selectedReplicateModel.inputs.find(
            (f) => f.name === map.duration,
          );
          const constraint = durationConstraintFromField(field);
          return constraint
            ? nearestAllowedDuration(clipDurationSec, constraint)
            : null;
        })()
      : null;

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

  if (phase === "error" && (activeSession || draftError)) {
    const errorText = activeSession?.errorMessage ?? draftError ?? "";
    const canRetryDownload =
      Boolean(clip.addAssetDraft?.replicatePredictionId?.trim()) ||
      isDownloadRetryableError(errorText);
    return (
      <div className="add-asset-generate-pane" role="alert">
        <div className="add-asset-generate-body">
          <p className="add-asset-generate-error">{errorText}</p>
          {canRetryDownload ? (
            <p className="muted" style={{ margin: "0 0 0.75rem" }}>
              Replicate finished this run — retry the download without generating
              again.
            </p>
          ) : null}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (canRetryDownload) onRetryDownload?.();
                else onClearError?.();
              }}
            >
              {canRetryDownload ? "Retry download" : "Try again"}
            </button>
            {canRetryDownload ? (
              <button
                type="button"
                className="btn"
                onClick={() => onClearError?.()}
              >
                Edit & regenerate
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const showFirstLast = resolvedContinuityMode === "first_last";
  const showMotionMatch = resolvedContinuityMode === "motion_match";
  const showImagesNone = !isReplicate && resolvedContinuityMode === "none";
  const firstPreview = showFirstLast ? bridge?.first ?? null : startFrame;
  const lastPreview = showFirstLast ? bridge?.last ?? null : null;

  return (
    <div className="add-asset-generate-pane">
      <header className="add-asset-generate-header">
        <button
          type="button"
          className="add-asset-generate-back"
          onClick={onBackToProvider}
          aria-label="Choose generation provider"
          title="Choose generation provider"
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
            <path
              fill="currentColor"
              d="M9.8 2.2 4 8l5.8 5.8 1.1-1.1L6.2 8l4.7-4.7z"
            />
          </svg>
        </button>
        <div>
          <h2>{isReplicate ? "Replicate" : "Parascene Blue"}</h2>
          <p>Timeline video fill</p>
        </div>
      </header>
      <div className="add-asset-generate-body">
        {isReplicate ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout" role="note">
              <p className="muted" style={{ margin: 0 }}>
                Replicate timeline fill — uses your Lab-enabled models. Constraints
                are checked as you change model, duration, or continuity.
              </p>
            </div>
          </section>
        ) : null}

        {isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Continuity</h3>
            <div
              className="add-asset-generate-audio-toggle"
              role="group"
              aria-label="Continuity mode"
            >
              {bridgeAvailable ? (
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
              ) : null}
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
              <button
                type="button"
                className={
                  resolvedContinuityMode === "motion_match" ? "is-active" : ""
                }
                onClick={() => setContinuityMode("motion_match")}
                aria-pressed={resolvedContinuityMode === "motion_match"}
              >
                Motion match
              </button>
            </div>
          </section>
        ) : null}

        {!isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Model</h3>
            <div
              className="add-asset-generate-audio-toggle"
              role="group"
              aria-label="Parascene Blue model"
            >
              <button
                type="button"
                className={resolvedBlueModel === "wan" ? "is-active" : ""}
                disabled={phase !== "form"}
                onClick={() => selectBlueModel("wan")}
                aria-pressed={resolvedBlueModel === "wan"}
              >
                WAN
              </button>
              <button
                type="button"
                className={resolvedBlueModel === "ltx" ? "is-active" : ""}
                disabled={phase !== "form"}
                onClick={() => selectBlueModel("ltx")}
                aria-pressed={resolvedBlueModel === "ltx"}
              >
                LTX
              </button>
            </div>
          </section>
        ) : null}

        {!isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Images</h3>
            <div
              className="add-asset-generate-audio-toggle"
              role="group"
              aria-label="Images mode"
            >
              <button
                type="button"
                className={resolvedContinuityMode === "none" ? "is-active" : ""}
                disabled={phase !== "form"}
                onClick={() => selectImagesMode("none")}
                aria-pressed={resolvedContinuityMode === "none"}
              >
                None
              </button>
              <button
                type="button"
                className={
                  resolvedContinuityMode === "start_frame" ? "is-active" : ""
                }
                disabled={phase !== "form"}
                onClick={() => selectImagesMode("start_frame")}
                aria-pressed={resolvedContinuityMode === "start_frame"}
              >
                Start frame
              </button>
              {resolvedBlueModel === "wan" && bridgeAvailable ? (
                <button
                  type="button"
                  className={
                    resolvedContinuityMode === "first_last" ? "is-active" : ""
                  }
                  disabled={phase !== "form"}
                  onClick={() => selectImagesMode("first_last")}
                  aria-pressed={resolvedContinuityMode === "first_last"}
                >
                  First + last frame
                </button>
              ) : null}
            </div>
            {resolvedContinuityMode === "none" ? (
              <p className="muted add-asset-generate-note">
                Text-to-video — no start image. Prompt only.
              </p>
            ) : null}
          </section>
        ) : null}

        {!isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Source audio</h3>
            <div
              className="add-asset-generate-audio-toggle"
              role="group"
              aria-label="Source audio"
            >
              <button
                type="button"
                className={resolvedAudioMode === "none" ? "is-active" : ""}
                disabled={phase !== "form"}
                onClick={() => selectSourceAudio("none")}
                aria-pressed={resolvedAudioMode === "none"}
              >
                None
              </button>
              <button
                type="button"
                className={
                  resolvedAudioMode === "full_mix" ? "is-active" : ""
                }
                disabled={phase !== "form" || sourceAudioLocked}
                onClick={() => selectSourceAudio("full_mix")}
                aria-pressed={resolvedAudioMode === "full_mix"}
                title={
                  resolvedContinuityMode === "none"
                    ? "Text-to-video has no audio processing"
                    : resolvedBlueModel === "wan"
                      ? "WAN has no audio processing"
                      : !hasMainAudio
                        ? "Add main audio to the timeline (or set it in Lab)"
                        : undefined
                }
              >
                Full track
              </button>
              <button
                type="button"
                className={resolvedAudioMode === "vocals" ? "is-active" : ""}
                disabled={
                  phase !== "form" || sourceAudioLocked || !hasLyrics
                }
                onClick={() => selectSourceAudio("vocals")}
                aria-pressed={resolvedAudioMode === "vocals"}
                title={
                  resolvedContinuityMode === "none"
                    ? "Text-to-video has no audio processing"
                    : resolvedBlueModel === "wan"
                      ? "WAN has no audio processing"
                      : !hasMainAudio
                        ? "Add main audio to the timeline (or set it in Lab)"
                        : !hasLyrics
                          ? "No lyrics in this section"
                          : undefined
                }
              >
                Lyrics track
              </button>
            </div>
            {resolvedContinuityMode === "none" ? (
              <p className="muted add-asset-generate-note">
                {ADD_ASSET_IMAGES_NONE_AUDIO_NOTE}
              </p>
            ) : resolvedBlueModel === "wan" ? (
              <p className="muted add-asset-generate-note">
                {ADD_ASSET_WAN_AUDIO_NOTE}
              </p>
            ) : !hasMainAudio ? (
              <p className="muted add-asset-generate-note">
                No audio track — source audio is locked to None. Add main audio
                to the timeline (or set it in Lab) to unlock Full or Lyrics
                track.
              </p>
            ) : null}
          </section>
        ) : null}

        {isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Model</h3>
            {replicateModelsError ? (
              <p className="add-asset-generate-error">{replicateModelsError}</p>
            ) : null}
            {replicateModels == null ? (
              <p className="muted">Loading enabled models…</p>
            ) : replicateModels.length === 0 ? (
              <p className="muted">
                No enabled Replicate video models. Enable models in Lab →
                Replicate.
              </p>
            ) : (
              <label className="add-asset-generate-field">
                <span>Enabled model</span>
                <select
                  className="control"
                  value={selectedReplicateModel?.id ?? ""}
                  disabled={phase !== "form"}
                  onChange={(event) => {
                    setReplicateModelId(event.target.value || null);
                    setUseNearestDuration(false);
                  }}
                >
                  {replicateModels.map((m) => {
                    const reason = replicateModelOptionDisabledReason(
                      m,
                      resolvedContinuityMode as ReplicateVideoContinuity,
                      clipDurationSec,
                      aspectRatio,
                      hasImageInput,
                    );
                    return (
                      <option
                        key={m.id}
                        value={m.id}
                        disabled={Boolean(reason)}
                      >
                        {m.label}
                        {reason ? ` — ${reason}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            )}
          </section>
        ) : null}

        {isReplicate && tweakFields && hasAnyReplicateTweaks(tweakFields) ? (
          <section className="add-asset-generate-section">
            <h3>Model options</h3>
            <div className="add-asset-generate-tweak-grid">
              {tweakFields.resolution?.enumValues?.length ? (
                <label className="add-asset-generate-field">
                  <span>Resolution</span>
                  <select
                    className="control"
                    value={normalizedTweaks.resolution ?? ""}
                    disabled={phase !== "form"}
                    onChange={(event) =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        resolution: event.target.value,
                      }))
                    }
                  >
                    {tweakFields.resolution.enumValues.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {tweakFields.mode?.enumValues?.length ? (
                <label className="add-asset-generate-field">
                  <span>Quality</span>
                  <select
                    className="control"
                    value={normalizedTweaks.mode ?? ""}
                    disabled={phase !== "form"}
                    onChange={(event) =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        mode: event.target.value,
                      }))
                    }
                  >
                    {tweakFields.mode.enumValues.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {tweakFields.audio ? (
                <div
                  className="add-asset-generate-audio-toggle"
                  role="group"
                  aria-label="Model audio"
                >
                  <button
                    type="button"
                    className={
                      normalizedTweaks.generateAudio ? "" : "is-active"
                    }
                    disabled={phase !== "form"}
                    onClick={() =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        generateAudio: false,
                      }))
                    }
                    aria-pressed={!normalizedTweaks.generateAudio}
                  >
                    No model audio
                  </button>
                  <button
                    type="button"
                    className={
                      normalizedTweaks.generateAudio ? "is-active" : ""
                    }
                    disabled={phase !== "form"}
                    onClick={() =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        generateAudio: true,
                      }))
                    }
                    aria-pressed={Boolean(normalizedTweaks.generateAudio)}
                  >
                    Generate audio
                  </button>
                </div>
              ) : null}

              {tweakFields.characterOrientation?.enumValues?.length ? (
                <label className="add-asset-generate-field">
                  <span>Character orientation</span>
                  <select
                    className="control"
                    value={normalizedTweaks.characterOrientation ?? ""}
                    disabled={phase !== "form"}
                    onChange={(event) =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        characterOrientation: event.target.value,
                      }))
                    }
                  >
                    {tweakFields.characterOrientation.enumValues.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {tweakFields.keepOriginalSound ? (
                <div
                  className="add-asset-generate-audio-toggle"
                  role="group"
                  aria-label="Reference video sound"
                >
                  <button
                    type="button"
                    className={
                      normalizedTweaks.keepOriginalSound ? "is-active" : ""
                    }
                    disabled={phase !== "form"}
                    onClick={() =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        keepOriginalSound: true,
                      }))
                    }
                    aria-pressed={Boolean(normalizedTweaks.keepOriginalSound)}
                  >
                    Keep ref sound
                  </button>
                  <button
                    type="button"
                    className={
                      normalizedTweaks.keepOriginalSound ? "" : "is-active"
                    }
                    disabled={phase !== "form"}
                    onClick={() =>
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        keepOriginalSound: false,
                      }))
                    }
                    aria-pressed={!normalizedTweaks.keepOriginalSound}
                  >
                    Drop ref sound
                  </button>
                </div>
              ) : null}

              {tweakFields.seed ? (
                <label className="add-asset-generate-field">
                  <span>Seed (optional)</span>
                  <input
                    className="control"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="Random"
                    disabled={phase !== "form"}
                    value={
                      typeof normalizedTweaks.seed === "number"
                        ? String(normalizedTweaks.seed)
                        : ""
                    }
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      if (!raw) {
                        setReplicateTweaks((prev) => ({
                          ...prev,
                          seed: null,
                        }));
                        return;
                      }
                      const n = Number(raw);
                      setReplicateTweaks((prev) => ({
                        ...prev,
                        seed: Number.isFinite(n) ? Math.floor(n) : null,
                      }));
                    }}
                  />
                </label>
              ) : null}
            </div>

            {tweakFields.negativePrompt ? (
              <label
                className="add-asset-generate-prompt-label"
                htmlFor="add-asset-negative-prompt"
                style={{ marginTop: 12, display: "block" }}
              >
                <span>Negative prompt</span>
                <textarea
                  id="add-asset-negative-prompt"
                  className="control add-asset-generate-prompt"
                  rows={2}
                  disabled={phase !== "form"}
                  value={normalizedTweaks.negativePrompt ?? ""}
                  onChange={(event) =>
                    setReplicateTweaks((prev) => ({
                      ...prev,
                      negativePrompt: event.target.value,
                    }))
                  }
                  placeholder="Things to avoid in the video…"
                />
              </label>
            ) : null}

            {tweakFields.audio ? (
              <p className="muted" style={{ margin: "8px 0 0" }}>
                Model audio is off by default so it does not fight the timeline
                song.
              </p>
            ) : null}
          </section>
        ) : null}

        {showImagesNone ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout" role="note">
              <p className="muted" style={{ margin: 0 }}>
                No start image — generation uses your prompt only (
                {resolvedBlueModel === "wan" ? "wan_t2v" : "ltx_t2v"}).
              </p>
            </div>
          </section>
        ) : (
        <section className="add-asset-generate-section">
          <h3>
            {showMotionMatch
              ? "Character & motion"
              : showFirstLast
                ? "First & last frames"
                : "Start frame"}
          </h3>
          <label className="add-asset-generate-field">
            <span>Framing</span>
            <select
              className="control"
              value={startFrameFraming}
              disabled={phase !== "form" || framesLoading}
              onChange={(event) =>
                setStartFrameFraming(
                  normalizeFraming(event.target.value as StagedClipFraming),
                )
              }
            >
              <option value="fit">Fit — letterbox into project frame</option>
              <option value="fill">Fill — cover and crop to project frame</option>
              <option value="stretch">
                Stretch — distort to fill project frame
              </option>
            </select>
          </label>
          <p className="muted add-asset-generate-note">
            How the still is mapped into the project aspect before generation.
          </p>
          {showMotionMatch ? (
            <div className="add-asset-generate-frame-pair">
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">
                  Character
                </span>
                <FramePreview
                  aspectRatio={aspectRatio}
                  loading={framesLoading}
                  loadingLabel="Loading character still…"
                  preview={startFrame}
                  emptyLabel="No previous clip for character still."
                  alt="Character still from previous clip"
                />
              </div>
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">
                  Motion video
                </span>
                <div className="add-asset-generate-callout">
                  <p className="muted" style={{ margin: 0 }}>
                    {motionVideoPath
                      ? "Using the previous timeline clip as the motion reference."
                      : "Need a previous video clip on the timeline for motion match."}
                  </p>
                </div>
              </div>
            </div>
          ) : showFirstLast ? (
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
                emptyLabel={
                  startFrameAssetId
                    ? "Selected image is not available locally yet — sync or download it."
                    : "No prior clip with a local still — choose an image below or place a clip before this gap."
                }
                alt="Start frame"
              />
              {!isReplicate && resolvedContinuityMode === "start_frame" ? (
                <StartFrameAssetPicker
                  assets={imageAssets}
                  selectedId={startFrameAssetId}
                  previewsById={assetPreviews}
                  disabled={phase !== "form" || framesLoading}
                  onSelect={setStartFrameAssetId}
                  onClear={() => setStartFrameAssetId(null)}
                />
              ) : null}
              {startFrame?.note ? (
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  {startFrame.note}
                </p>
              ) : null}
            </div>
          )}
        </section>
        )}

        <section className="add-asset-generate-section">
          <h3>Duration</h3>
          <label className="add-asset-generate-field">
            <span>Seconds</span>
            <input
              className="control"
              type="number"
              min={ADD_ASSET_MIN_DURATION_SEC}
              max={ADD_ASSET_MAX_DURATION_SEC}
              step={0.5}
              value={durationDraft}
              disabled={phase !== "form"}
              onChange={(event) => {
                setDurationDraft(event.target.value);
                setUseNearestDuration(false);
              }}
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

        {isReplicate &&
        (replicateValidation?.blockers.length ||
          replicateValidation?.notes.length) ? (
          <section className="add-asset-generate-section">
            <div
              className="add-asset-generate-callout"
              role="status"
              aria-label="Replicate constraints"
            >
              {replicateValidation?.blockers.map((b) => (
                <p key={b} className="add-asset-generate-error" style={{ margin: 0 }}>
                  {b}
                </p>
              ))}
              {replicateValidation?.notes.map((n) => (
                <p key={n} className="muted" style={{ margin: 0 }}>
                  {n}
                </p>
              ))}
              {durationBlocker && nearestDuration != null && !useNearestDuration ? (
                <button
                  type="button"
                  className="btn ghost"
                  style={{ marginTop: 8 }}
                  onClick={() => setUseNearestDuration(true)}
                >
                  Use nearest allowed ({nearestDuration}s)
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {!isReplicate &&
        resolvedAudioMode === "vocals" &&
        hasLyrics ? (
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
              ref={promptRef}
              className="add-asset-generate-prompt is-auto-size"
              rows={2}
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
