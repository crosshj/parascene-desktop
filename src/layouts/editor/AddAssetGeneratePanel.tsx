import {
  CloneButton,
  DiscardButton,
  GenerateTargetButton,
  TryAgainButton,
} from "./AddAssetIntentFooter";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LAB_A2V_PROMPT } from "../../lab/labPrompts";
import { getCreations } from "../../library/catalogClient";
import { creationPreviewUrl } from "../../library/previewUrl";
import type {
  AddAssetDraft,
  AddAssetFrameSource,
  AddAssetGeneration,
  LyricAlignment,
  ProjectAsset,
  TimelineClip,
} from "../../project/types";
import {
  continuityFromFrameSources,
  frameSourceAssetId,
  frameSourceIsSet,
  frameSourcesEqual,
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "../../project/addAssetFrameSource";
import {
  loadGenerationFramePreviews,
  resolveGenerationFramePreviews,
} from "../../project/generationFramePreviews";
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
  type AddAssetBlueModel,
  type AddAssetContinuityMode,
  type AddAssetGenerationSession,
  type RunAddAssetGenerationOpts,
} from "./addAssetGenerate";
import { resolveLyricsForTimeRange, matchingLyricAlignment } from "./addAssetLyrics";
import {
  peekTimelineFrameSlot,
  resolveAddAssetBridgeFramesFromSources,
  resolveAddAssetGenerationTiming,
  resolveFrameSlot,
  resolveStartFrameForAddAsset,
  framePathBasename,
  startFrameIsReady,
  type BridgeFrames,
  type StartFramePreview,
} from "./addAssetStartFrame";
import { GenerateFrameSourcePicker } from "./GenerateFrameSourcePicker";
import {
  ADD_ASSET_MAX_DURATION_SEC,
  ADD_ASSET_MIN_DURATION_SEC,
  addAssetClipDurationSec,
  clampAddAssetDurationSec,
  withAddAssetDuration,
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
import {
  blueMethodForTimelineFill,
  filterBlueVideoModels,
  isWanFamilyBlueModel,
  loadBlueVideoModels,
  pickCompatibleBlueModel,
  type BlueVideoModelOption,
} from "./blueVideoModels";
import { parasceneVideoModelsForIntent } from "./parasceneProductCaps";
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
  /** Parascene / Blue model when not generating via Replicate. */
  blueModel?: AddAssetBlueModel;
  songRange: { startSec: number; endSec: number };
  startFrame: StartFramePreview;
  endFrame?: StartFramePreview | null;
  /** Present when generating via Replicate timeline fill. */
  replicate?: RunAddAssetGenerationOpts["replicate"];
  /** Direct to Blue (local-only) timeline fill. */
  blueDirect?: boolean;
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
  /** Omit Back/header when nested under the intent-first shell. */
  embedded?: boolean;
  /**
   * When true, running/error progress lives on the Result pane — keep showing
   * the literal form (locked while running) instead of replacing it.
   */
  progressHostedExternally?: boolean;
  /** Force non-interactive form (e.g. finished generation review). */
  formLocked?: boolean;
  /** Replaces Generate when the form is locked for review. */
  onGenerateNew?: () => void;
  /** Dual-view failure recovery in the footer while the form stays visible. */
  errorRecovery?: {
    onDiscard?: () => void;
    onRetry?: () => void;
  };
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
    typeof draft?.blueModel === "string" && draft.blueModel.trim()
      ? draft.blueModel.trim()
      : continuity === "first_last"
        ? "wan_i2v"
        : continuity === "start_frame" || continuity === "none"
          ? "ltx_i2v"
          : null;
  const audioMode: AddAssetAudioMode =
    draft?.audioMode === "vocals" ||
    draft?.audioMode === "full_mix" ||
    draft?.audioMode === "none"
      ? draft.audioMode
      : blueModel && isWanFamilyBlueModel(blueModel)
        ? "none"
        : continuity === "none"
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

function generationJobsEqual(
  a: AddAssetDraft["generationJob"],
  b: AddAssetDraft["generationJob"],
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.status === b.status &&
    a.provider === b.provider &&
    a.startedAt === b.startedAt &&
    (a.replicatePredictionId ?? "") === (b.replicatePredictionId ?? "") &&
    (a.pendingCreationId ?? "") === (b.pendingCreationId ?? "") &&
    (a.blueJobId ?? "") === (b.blueJobId ?? "") &&
    (a.model ?? "") === (b.model ?? "")
  );
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
    (a.blueJobId ?? "") === (b?.blueJobId ?? "") &&
    generationJobsEqual(a.generationJob, b?.generationJob) &&
    replicateTweaksEqual(a.replicateTweaks, b?.replicateTweaks) &&
    (a.startFrameAssetId ?? "") === (b?.startFrameAssetId ?? "") &&
    frameSourcesEqual(a.firstFrameSource, b?.firstFrameSource) &&
    frameSourcesEqual(a.lastFrameSource, b?.lastFrameSource) &&
    (a.startFramePreviewUrl ?? "") === (b?.startFramePreviewUrl ?? "") &&
    (a.endFramePreviewUrl ?? "") === (b?.endFramePreviewUrl ?? "")
  );
}

import {
  resolveAddAssetIntent,
  serverLabel,
  intentLabel,
  type GenerateIntentId,
  type GenerateServerId,
} from "./previewIntent";
import { blueCredentialsStatus } from "../../blue/blueClient";
import {
  BLUE_CREDENTIALS_CHANGED_EVENT,
  requestOpenSettings,
} from "../../settings/events";

function draftServer(clip: TimelineClip): GenerateServerId {
  const resolved = resolveAddAssetIntent(clip.addAssetDraft ?? {});
  return resolved?.server ?? "parascene_blue";
}

function draftIntentId(clip: TimelineClip): GenerateIntentId {
  const resolved = resolveAddAssetIntent(clip.addAssetDraft ?? {});
  return resolved?.intentId ?? "image_to_video";
}

function isReplicateTimelineFill(clip: TimelineClip): boolean {
  return draftServer(clip) === "replicate";
}

function isBlueDirectTimelineFill(clip: TimelineClip): boolean {
  return draftServer(clip) === "blue_direct";
}

function GenerateActions({
  onGenerate,
  onGenerateNew,
  generateDisabled,
  formLocked,
  errorRecovery,
}: {
  onGenerate: () => void;
  onGenerateNew?: () => void;
  generateDisabled: boolean;
  formLocked?: boolean;
  errorRecovery?: {
    onDiscard?: () => void;
    onRetry?: () => void;
  };
}) {
  if (
    formLocked &&
    errorRecovery &&
    (errorRecovery.onDiscard || errorRecovery.onRetry)
  ) {
    return (
      <div className="add-asset-generate-footer preview-intent-footer">
        {errorRecovery.onRetry ? (
          <TryAgainButton onClick={errorRecovery.onRetry} />
        ) : null}
        {errorRecovery.onDiscard ? (
          <DiscardButton onClick={errorRecovery.onDiscard} />
        ) : null}
      </div>
    );
  }
  if (formLocked && onGenerateNew) {
    return (
      <div className="add-asset-generate-footer preview-intent-footer">
        <CloneButton onClick={onGenerateNew} />
      </div>
    );
  }
  return (
    <div className="add-asset-generate-footer preview-intent-footer">
      <GenerateTargetButton
        target="Video"
        disabled={generateDisabled || formLocked}
        onClick={onGenerate}
      />
    </div>
  );
}

function timelineFingerprint(timeline: readonly TimelineClip[]): string {
  return timeline
    .map(
      (clip) =>
        [
          clip.id,
          clip.startSec.toFixed(3),
          clip.endSec.toFixed(3),
          clip.assetId ?? "",
          clip.inSec ?? 0,
          clip.outSec ?? "",
          clip.framing ?? "fit",
          clip.reverse ? 1 : 0,
          clip.extendPingPong === true ? 1 : 0,
          clip.extendSourceSpanSec ?? "",
          clip.speed ?? 1,
          clip.zoom ?? 1,
          clip.centerX ?? 0.5,
          clip.centerY ?? 0.5,
        ].join(":"),
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

function frameSourceKey(source: AddAssetFrameSource): string {
  if (source.kind === "asset") return `asset:${source.assetId}`;
  return source.kind;
}

const TIMELINE_FRAME_SOURCE: AddAssetFrameSource = { kind: "timeline" };
const NONE_FRAME_SOURCE: AddAssetFrameSource = { kind: "none" };

function frameSourceCaption(
  source: AddAssetFrameSource,
  role: "first" | "last",
  imageAssets: readonly ProjectAsset[],
): string {
  if (source.kind === "none") return "None";
  if (source.kind === "asset") {
    const name = imageAssets.find((a) => a.id === source.assetId)?.name?.trim();
    return name || "Assets image";
  }
  return role === "last" ? "Next clip" : "Previous clip";
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
  onRetryDownload,
  imageAssets = [],
  embedded = false,
  progressHostedExternally = false,
  formLocked = false,
  onGenerateNew,
  errorRecovery,
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
  const isBlueDirect = isBlueDirectTimelineFill(clip);
  const currentIntentId = draftIntentId(clip);
  const currentServer = draftServer(clip);
  const draftFirstSource = clip.addAssetDraft?.firstFrameSource;
  const draftStartFrameAssetId = clip.addAssetDraft?.startFrameAssetId;
  const draftLastSource = clip.addAssetDraft?.lastFrameSource;
  const draftContinuity = clip.addAssetDraft?.continuityMode;
  const firstFrameSource: AddAssetFrameSource = useMemo(
    () =>
      resolveFirstFrameSource({
        firstFrameSource: draftFirstSource,
        startFrameAssetId: draftStartFrameAssetId,
      }) ?? TIMELINE_FRAME_SOURCE,
    [draftFirstSource, draftStartFrameAssetId],
  );
  const lastFrameSource: AddAssetFrameSource = useMemo(() => {
    const raw = resolveLastFrameSource({
      lastFrameSource: draftLastSource,
      continuityMode: draftContinuity,
    });
    if (raw.kind === "timeline") return TIMELINE_FRAME_SOURCE;
    if (raw.kind === "none") return NONE_FRAME_SOURCE;
    return raw;
  }, [draftLastSource, draftContinuity]);
  const startFrameAssetId = frameSourceAssetId(firstFrameSource);
  const [prompt, setPrompt] = useState(initial.prompt);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [audioMode, setAudioMode] = useState<AddAssetAudioMode>(
    initial.audioMode,
  );
  /** null = auto from first/last slots; motion_match is explicit (Replicate). */
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
  const [blueModels, setBlueModels] = useState<BlueVideoModelOption[] | null>(
    null,
  );
  const [blueModelsError, setBlueModelsError] = useState<string | null>(null);
  const [motionVideoPath, setMotionVideoPath] = useState<string | null>(null);
  const [blueConfigured, setBlueConfigured] = useState<boolean | null>(null);
  const [assetPreviews, setAssetPreviews] = useState<Record<string, string | null>>(
    {},
  );
  const [catalogFramePreviews, setCatalogFramePreviews] = useState<{
    key: string;
    startPreviewUrl: string | null;
    endPreviewUrl: string | null;
  } | null>(null);
  const [framePickerSlot, setFramePickerSlot] = useState<"first" | "last" | null>(
    null,
  );
  const [pickerTimelinePreview, setPickerTimelinePreview] =
    useState<StartFramePreview | null>(null);
  const [pickerTimelineLoading, setPickerTimelineLoading] = useState(false);
  const [pickerSlotSeen, setPickerSlotSeen] = useState(framePickerSlot);

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

  const framesKey = `${timelineKey}:${clip.id}:${aspectRatio}:frame-v9:${pullEpoch}:${frameSourceKey(firstFrameSource)}:${frameSourceKey(lastFrameSource)}`;
  const activeSession = session?.clipId === clip.id ? session : null;
  const draftError = clip.addAssetDraft?.lastError?.trim() || null;
  const phase: PanelPhase =
    activeSession?.phase ?? (draftError ? "error" : "form");
  /** Form stays visible but non-interactive while running / reviewing. */
  const fieldsInteractive = !formLocked && phase !== "running";

  // Shared Form start/last still path (same helper as locked I2I review).
  const frameReviewGeneration: AddAssetGeneration | null =
    clip.addAssetGeneration ??
    (clip.addAssetDraft
      ? {
          prompt: clip.addAssetDraft.prompt ?? "",
          generatedAt: "",
          creationId: "",
          mode: clip.addAssetDraft.continuityMode,
          startFrameAssetId: clip.addAssetDraft.startFrameAssetId,
          firstFrameSource: clip.addAssetDraft.firstFrameSource,
          lastFrameSource: clip.addAssetDraft.lastFrameSource,
          startFramePreviewUrl: clip.addAssetDraft.startFramePreviewUrl,
          endFramePreviewUrl: clip.addAssetDraft.endFramePreviewUrl,
        }
      : null);
  const syncFramePreviews = resolveGenerationFramePreviews(frameReviewGeneration);
  const catalogHit =
    catalogFramePreviews?.key === framesKey ? catalogFramePreviews : null;
  const stampedStartUrl =
    catalogHit?.startPreviewUrl || syncFramePreviews.startPreviewUrl || null;
  const stampedEndUrl =
    catalogHit?.endPreviewUrl || syncFramePreviews.endPreviewUrl || null;
  const stampedStartAssetId =
    syncFramePreviews.startAssetId || startFrameAssetId || null;
  const stampedStart: StartFramePreview | null = stampedStartUrl
    ? {
        previewUrl: stampedStartUrl,
        note: "",
        framePath: null,
        frameTimeSec: null,
        sourceAssetId: stampedStartAssetId,
        sourceIsImage: Boolean(stampedStartAssetId),
      }
    : null;
  const stampedBridge: BridgeFrames | null =
    stampedStart && stampedEndUrl
      ? {
          first: stampedStart,
          last: {
            previewUrl: stampedEndUrl,
            note: "",
            framePath: null,
            frameTimeSec: null,
          },
        }
      : stampedStart &&
          (clip.addAssetGeneration?.mode === "start_frame" ||
            clip.addAssetDraft?.continuityMode === "start_frame")
        ? { first: stampedStart, last: stampedStart }
        : null;
  // Locked review with a known start asset id waits on catalog load — do not
  // re-extract timeline frames.
  const stampedPendingCatalog =
    formLocked &&
    Boolean(stampedStartAssetId) &&
    !stampedStartUrl &&
    Boolean(clip.addAssetGeneration || clip.addAssetDraft);
  const stampedEmpty =
    (formLocked && clip.addAssetGeneration?.mode === "none") ||
    (formLocked &&
      !stampedStartAssetId &&
      !stampedStartUrl &&
      !frameSourceIsSet(firstFrameSource) &&
      !frameSourceIsSet(lastFrameSource) &&
      Boolean(clip.addAssetGeneration));
  const stampedLoaded =
    stampedBridge != null
      ? { key: framesKey, start: stampedStart, bridge: stampedBridge }
      : stampedPendingCatalog || stampedEmpty
        ? {
            key: framesKey,
            start: null as StartFramePreview | null,
            bridge: null as BridgeFrames | null,
          }
        : null;

  const stampedFramesReady = stampedLoaded != null;
  const resolvedFrames =
    loadedFrames?.key === framesKey ? loadedFrames : stampedLoaded;
  const framesReady = resolvedFrames?.key === framesKey;
  const startFrame = framesReady ? resolvedFrames.start : null;
  const bridge = framesReady ? resolvedFrames.bridge : null;
  const bridgeReady = Boolean(
    bridge &&
      startFrameIsReady(bridge.first) &&
      startFrameIsReady(bridge.last),
  );
  const framesLoading = !framesReady;

  const hasLyrics = Boolean(lyricsText.trim());
  const hasMainAudio = Boolean(mainAudioCreationId?.trim());

  const resolvedContinuityMode: AddAssetContinuityMode = (() => {
    if (isReplicate && continuityMode === "motion_match") return "motion_match";
    if (!isReplicate && currentIntentId === "text_to_video") return "none";
    return continuityFromFrameSources(firstFrameSource, lastFrameSource);
  })();

  const tentativeAudioMode: AddAssetAudioMode =
    audioMode === "none" ||
    resolvedContinuityMode === "none" ||
    resolvedContinuityMode === "first_last" ||
    !hasMainAudio
      ? "none"
      : !hasLyrics
        ? "full_mix"
        : audioMode === "full_mix"
          ? "full_mix"
          : "vocals";

  const blueMethod = blueMethodForTimelineFill({
    continuity: resolvedContinuityMode,
    audioMode: isReplicate ? "none" : tentativeAudioMode,
  });

  const isParasceneProductAdvanced =
    !isReplicate &&
    !isBlueDirect &&
    (currentIntentId === "video_to_video" ||
      currentIntentId === "reference_to_video");

  const parasceneCapsModels = useMemo((): BlueVideoModelOption[] => {
    if (!isParasceneProductAdvanced) return [];
    return parasceneVideoModelsForIntent(currentIntentId).map((m) => ({
      id: m.id,
      label: m.label,
      method: m.method as BlueVideoModelOption["method"],
      flf: m.flf,
      nativeAudio: m.nativeAudio,
      hint: m.hint,
    }));
  }, [isParasceneProductAdvanced, currentIntentId]);

  const compatibleBlueModels = useMemo(() => {
    if (isParasceneProductAdvanced) return parasceneCapsModels;
    if (isReplicate || !blueModels) return [];
    return filterBlueVideoModels({
      models: blueModels,
      method: blueMethod,
      continuity: resolvedContinuityMode,
      blueDirect: isBlueDirect,
    });
  }, [
    isParasceneProductAdvanced,
    parasceneCapsModels,
    isReplicate,
    blueModels,
    blueMethod,
    resolvedContinuityMode,
    isBlueDirect,
  ]);

  const resolvedBlueModel: string = (() => {
    if (isReplicate) return "ltx_i2v";
    if (isParasceneProductAdvanced && parasceneCapsModels.length > 0) {
      const preferred =
        blueModel?.trim() ||
        clip.addAssetDraft?.blueModel?.trim() ||
        clip.addAssetGeneration?.model?.trim();
      if (preferred && parasceneCapsModels.some((m) => m.id === preferred)) {
        return preferred;
      }
      return parasceneCapsModels[0]?.id ?? preferred ?? "wan_animate";
    }
    if (!blueModels?.length) {
      return (
        blueModel?.trim() ||
        clip.addAssetDraft?.blueModel?.trim() ||
        clip.addAssetGeneration?.model?.trim() ||
        "ltx_i2v"
      );
    }
    const picked = pickCompatibleBlueModel({
      models: blueModels,
      method: blueMethod,
      continuity: resolvedContinuityMode,
      blueDirect: isBlueDirect,
      preferredId: blueModel,
    });
    return picked?.id ?? blueModel ?? "ltx_i2v";
  })();

  const hasA2vModels = useMemo(() => {
    if (isReplicate || !blueModels) return false;
    return filterBlueVideoModels({
      models: blueModels,
      method: "audio2video",
      continuity: "start_frame",
      blueDirect: isBlueDirect,
    }).length > 0;
  }, [isReplicate, blueModels, isBlueDirect]);

  const hasFlfModels = useMemo(() => {
    if (isReplicate || !blueModels) return false;
    return filterBlueVideoModels({
      models: blueModels,
      method: "image2video",
      continuity: "first_last",
      blueDirect: isBlueDirect,
    }).length > 0;
  }, [isReplicate, blueModels, isBlueDirect]);

  const sourceAudioLocked =
    !isReplicate &&
    (resolvedContinuityMode === "none" ||
      resolvedContinuityMode === "first_last" ||
      !hasMainAudio ||
      !hasA2vModels);

  const resolvedAudioMode: AddAssetAudioMode = (() => {
    if (isReplicate) {
      return hasLyrics ? (audioMode === "full_mix" ? "full_mix" : "vocals") : "full_mix";
    }
    if (sourceAudioLocked) return "none";
    return tentativeAudioMode;
  })();

  const selectBlueModel = (next: string) => {
    setBlueModel(next);
    if (isWanFamilyBlueModel(next) || next.includes("_t2v")) {
      setAudioMode("none");
    }
    const opt = blueModels?.find((m) => m.id === next);
    if (opt && !opt.flf && frameSourceIsSet(lastFrameSource)) {
      setFrameSources({ last: { kind: "none" } });
    }
  };

  const syncBlueModelForContinuity = (next: AddAssetContinuityMode) => {
    if (isReplicate || !blueModels) return;
    if (next === "first_last") {
      const flf = pickCompatibleBlueModel({
        models: blueModels,
        method: "image2video",
        continuity: "first_last",
        blueDirect: isBlueDirect,
        preferredId: blueModel,
      });
      if (flf) setBlueModel(flf.id);
      setAudioMode("none");
      return;
    }
    if (next === "start_frame") {
      const i2v = pickCompatibleBlueModel({
        models: blueModels,
        method: blueMethodForTimelineFill({
          continuity: "start_frame",
          audioMode: audioMode === "none" ? "none" : audioMode,
        }),
        continuity: "start_frame",
        blueDirect: isBlueDirect,
        preferredId: blueModel,
      });
      if (i2v) setBlueModel(i2v.id);
    }
  };

  const selectSourceAudio = (next: AddAssetAudioMode) => {
    if (sourceAudioLocked && next !== "none") return;
    if (next !== "none") {
      const a2v = pickCompatibleBlueModel({
        models: blueModels ?? [],
        method: "audio2video",
        continuity: "start_frame",
        blueDirect: isBlueDirect,
        preferredId: blueModel,
      });
      if (a2v) setBlueModel(a2v.id);
    } else if (blueMethod === "audio2video") {
      const i2v = pickCompatibleBlueModel({
        models: blueModels ?? [],
        method: "image2video",
        continuity: "start_frame",
        blueDirect: isBlueDirect,
        preferredId: blueModel,
      });
      if (i2v) setBlueModel(i2v.id);
    }
    setAudioMode(next);
  };

  // Keep draft audio locked to None for WAN, Text to Video, or when no main audio.
  useEffect(() => {
    if (!sourceAudioLocked) return;
    if (audioMode !== "none") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- lock source audio to none
      setAudioMode("none");
    }
  }, [sourceAudioLocked, audioMode]);

  useEffect(() => {
    if (!isBlueDirect) return;
    let cancelled = false;
    const refresh = () => {
      void blueCredentialsStatus()
        .then((s) => {
          if (!cancelled) setBlueConfigured(s.configured);
        })
        .catch(() => {
          if (!cancelled) setBlueConfigured(false);
        });
    };
    refresh();
    window.addEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
    };
  }, [isBlueDirect, clip.id]);
  if (!isBlueDirect && blueConfigured !== null) {
    setBlueConfigured(null);
  }

  // Load enabled Replicate video models once for this panel.
  useEffect(() => {
    if (!isReplicate || !fieldsInteractive) return;
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
  }, [isReplicate, phase, clip.id, fieldsInteractive]);

  // Load Blue method models (live capabilities with snapshot fallback).
  useEffect(() => {
    if (isReplicate || !fieldsInteractive) return;
    let cancelled = false;
    void (async () => {
      try {
        const models = await loadBlueVideoModels();
        if (cancelled) return;
        setBlueModels(models);
        setBlueModelsError(null);
      } catch (error) {
        if (cancelled) return;
        setBlueModels([]);
        setBlueModelsError(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReplicate, phase, clip.id, fieldsInteractive]);

  // Keep selected Blue model compatible with continuity / audio method.
  useEffect(() => {
    if (isReplicate || !blueModels || !fieldsInteractive) return;
    const next = pickCompatibleBlueModel({
      models: blueModels,
      method: blueMethod,
      continuity: resolvedContinuityMode,
      blueDirect: isBlueDirect,
      preferredId: blueModel,
    });
    if (next && next.id !== blueModel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- align model to method
      setBlueModel(next.id);
    }
  }, [
    isReplicate,
    blueModels,
    blueMethod,
    resolvedContinuityMode,
    isBlueDirect,
    blueModel,
    phase,
    fieldsInteractive,
  ]);

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
  const hasEndFrame = startFrameIsReady(bridge?.last);
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
    if (!isReplicate || !replicateModels || !fieldsInteractive) return;
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
    fieldsInteractive,
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

  // Load thumbnails for the frame-source Assets picker (interactive form only).
  useEffect(() => {
    if (!fieldsInteractive || imageAssets.length === 0) return;
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
  }, [imageAssets, fieldsInteractive]);

  // Persist form choices on the placeholder so they survive clip switches.
  // Skip while error/running — job lifecycle fields (lastError, generationJob)
  // are owned by the generation store; rewriting them here races "Try again".
  useEffect(() => {
    if (!fieldsInteractive) return;
    const next: AddAssetDraft = {
      prompt,
      audioMode: resolvedAudioMode,
      continuityMode: resolvedContinuityMode,
      blueModel: isReplicate ? undefined : resolvedBlueModel,
      intentId: currentIntentId,
      server: currentServer,
      provider: currentServer,
      methodId: currentIntentId,
      replicateModel: replicateModelId ?? undefined,
      useNearestDuration: useNearestDuration || undefined,
      lastError: clip.addAssetDraft?.lastError,
      replicatePredictionId: clip.addAssetDraft?.replicatePredictionId,
      blueJobId: clip.addAssetDraft?.blueJobId,
      generationJob: clip.addAssetDraft?.generationJob,
      replicateTweaks: isReplicate ? normalizedTweaks : undefined,
      startFrameAssetId: startFrameAssetId ?? undefined,
      firstFrameSource,
      lastFrameSource,
      // Keep Generate-new stamps — rewriting without them blanks FIRST/LAST.
      startFramePreviewUrl: clip.addAssetDraft?.startFramePreviewUrl,
      endFramePreviewUrl: clip.addAssetDraft?.endFramePreviewUrl,
    };
    if (draftsEqual(next, clip.addAssetDraft)) return;
    onDraftChange?.(next);
  }, [
    phase,
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
    firstFrameSource,
    lastFrameSource,
    onDraftChange,
    fieldsInteractive,
    currentIntentId,
    currentServer,
  ]);

  // Fill missing stamp URLs from catalog (locked Form included).
  useEffect(() => {
    if (!formLocked) return;
    const generation =
      clip.addAssetGeneration ??
      (clip.addAssetDraft
        ? {
            prompt: clip.addAssetDraft.prompt ?? "",
            generatedAt: "",
            creationId: "",
            mode: clip.addAssetDraft.continuityMode,
            startFrameAssetId: clip.addAssetDraft.startFrameAssetId,
            firstFrameSource: clip.addAssetDraft.firstFrameSource,
            lastFrameSource: clip.addAssetDraft.lastFrameSource,
            startFramePreviewUrl: clip.addAssetDraft.startFramePreviewUrl,
            endFramePreviewUrl: clip.addAssetDraft.endFramePreviewUrl,
          }
        : null);
    if (!generation) return;
    const sync = resolveGenerationFramePreviews(generation);
    const needsLoad =
      (Boolean(sync.startAssetId) && !sync.startPreviewUrl) ||
      (Boolean(sync.endAssetId) && !sync.endPreviewUrl);
    if (!needsLoad) return;
    let cancelled = false;
    void loadGenerationFramePreviews(generation).then((loaded) => {
      if (cancelled) return;
      setCatalogFramePreviews({
        key: framesKey,
        startPreviewUrl: loaded.startPreviewUrl,
        endPreviewUrl: loaded.endPreviewUrl,
      });
    });
    return () => {
      cancelled = true;
    };
    // framesKey + generation frame fields; avoid depending on a fresh object.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [
    formLocked,
    framesKey,
    clip.addAssetGeneration,
    clip.addAssetDraft?.startFramePreviewUrl,
    clip.addAssetDraft?.endFramePreviewUrl,
    clip.addAssetDraft?.startFrameAssetId,
    clip.addAssetDraft?.firstFrameSource,
    clip.addAssetDraft?.lastFrameSource,
    clip.addAssetDraft?.continuityMode,
  ]);

  useEffect(() => {
    let cancelled = false;
    // Stamped / locked-empty stills resolve synchronously via stampedLoaded.
    if (stampedFramesReady) return;

    void (async () => {
      const [start, last] = await Promise.all([
        resolveFrameSlot({
          role: "first",
          source: firstFrameSource,
          timeline,
          placeholder: clip,
          aspectRatio,
        }),
        resolveFrameSlot({
          role: "last",
          source: lastFrameSource,
          timeline,
          placeholder: clip,
          aspectRatio,
        }),
      ]);
      if (cancelled) return;
      setLoadedFrames({
        key: framesKey,
        start: stampedStart?.previewUrl ? stampedStart : start,
        bridge: {
          first: stampedStart?.previewUrl ? stampedStart : start,
          last:
            stampedEndUrl && stampedStart
              ? {
                  previewUrl: stampedEndUrl,
                  note: "",
                  framePath: null,
                  frameTimeSec: null,
                }
              : last,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
    // framesKey covers clip geometry / neighbors / sources; omit clip/timeline
    // objects so drafting the prompt does not re-extract frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [framesKey, aspectRatio, fieldsInteractive, formLocked, stampedFramesReady]);

  const bumpFrames = () => {
    setLoadedFrames(null);
    setPullEpoch((epoch) => epoch + 1);
  };

  const setFrameSources = (opts: {
    first?: AddAssetFrameSource;
    last?: AddAssetFrameSource;
  }) => {
    const nextFirst = opts.first ?? firstFrameSource;
    const nextLast = opts.last ?? lastFrameSource;
    const nextAssetId = frameSourceAssetId(nextFirst);
    const nextContinuity = continuityFromFrameSources(nextFirst, nextLast);
    if (continuityMode === "motion_match") {
      setContinuityMode(null);
    }
    syncBlueModelForContinuity(nextContinuity);
    onDraftChange?.({
      ...(clip.addAssetDraft ?? {}),
      firstFrameSource: nextFirst,
      lastFrameSource: nextLast,
      startFrameAssetId: nextAssetId ?? undefined,
      continuityMode: nextContinuity,
      // Source change invalidates cloned still stamps.
      startFramePreviewUrl: undefined,
      endFramePreviewUrl: undefined,
    });
    bumpFrames();
  };

  useEffect(() => {
    if (!framePickerSlot) return;
    let cancelled = false;
    void (async () => {
      const preview = await peekTimelineFrameSlot({
        role: framePickerSlot,
        timeline,
        placeholder: clip,
        aspectRatio,
      });
      if (cancelled) return;
      setPickerTimelinePreview(preview);
      setPickerTimelineLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [framePickerSlot, framesKey, aspectRatio]);
  if (framePickerSlot !== pickerSlotSeen) {
    setPickerSlotSeen(framePickerSlot);
    if (framePickerSlot) {
      setPickerTimelinePreview(null);
      setPickerTimelineLoading(true);
    } else {
      setPickerTimelinePreview(null);
      setPickerTimelineLoading(false);
    }
  }

  const handleGenerate = () => {
    if (!fieldsInteractive || !prompt.trim()) return;

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

      if (isParasceneProductAdvanced) {
        const freshStart = await resolveStartFrameForAddAsset(
          timeline,
          clip,
          aspectRatio,
          {
            firstFrameSource,
            startFrameAssetId,
          },
        );
        if (!startFrameIsReady(freshStart)) {
          abortGenerate(
            "missing_source_media",
            currentIntentId === "video_to_video"
              ? "Choose a source video (timeline neighbor or Assets video)."
              : "Choose at least one reference image from Assets.",
          );
          return;
        }
        onStartGeneration({
          clip: clipWithDuration,
          prompt,
          lyricsText,
          audioMode: "none",
          continuityMode: "start_frame",
          blueModel: resolvedBlueModel,
          songRange: timing.songRange,
          startFrame: freshStart,
          endFrame: null,
        });
        return;
      }

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

        const frameOpts = {
          firstFrameSource,
          lastFrameSource,
          startFrameAssetId,
        };
        const freshStart = await resolveStartFrameForAddAsset(
          timeline,
          clip,
          aspectRatio,
          frameOpts,
        );
        let endFrame: StartFramePreview | null = null;
        if (resolvedContinuityMode === "first_last") {
          const freshBridge = await resolveAddAssetBridgeFramesFromSources(
            timeline,
            clip,
            aspectRatio,
            frameOpts,
          );
          if (
            !freshBridge ||
            !startFrameIsReady(freshBridge.first) ||
            !startFrameIsReady(freshBridge.last)
          ) {
            abortGenerate(
              "missing_bridge_frames",
              "Could not resolve first/last frame stills. Choose timeline neighbors or Assets images and ensure they are available.",
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
              ? "Could not resolve the selected image on Parascene. Sync the asset, then try Generate again."
              : "Could not resolve a local start-frame still from the previous clip. Download the clip, use an image or video prior, then try Generate again.",
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
          blueDirect: isBlueDirect || undefined,
        });
        return;
      }
      if (useFirstLast) {
        const freshBridge = await resolveAddAssetBridgeFramesFromSources(
          timeline,
          clip,
          aspectRatio,
          {
            firstFrameSource,
            lastFrameSource,
            startFrameAssetId,
          },
        );
        if (
          !freshBridge ||
          !startFrameIsReady(freshBridge.first) ||
          !startFrameIsReady(freshBridge.last)
        ) {
          abortGenerate(
            "missing_bridge_frames",
            "Could not resolve first/last frame stills for generation. Choose timeline neighbors or Assets images and ensure they are available.",
          );
          return;
        }
        onStartGeneration({
          clip: clipWithDuration,
          prompt,
          lyricsText,
          audioMode: resolvedAudioMode,
          continuityMode: "first_last",
          blueModel: resolvedBlueModel,
          songRange: timing.songRange,
          startFrame: freshBridge.first,
          endFrame: freshBridge.last,
          blueDirect: isBlueDirect || undefined,
        });
        return;
      }

      const freshStart = await resolveStartFrameForAddAsset(
        timeline,
        clip,
        aspectRatio,
        {
          firstFrameSource,
          startFrameAssetId,
        },
      );
      if (!startFrameIsReady(freshStart)) {
        abortGenerate(
          "missing_start_frame",
          startFrameAssetId
            ? "Could not resolve the selected image on Parascene. Sync the asset, then try Generate again."
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
        blueDirect: isBlueDirect || undefined,
      });
    })();
  };

  const canGenerateBlue =
    fieldsInteractive &&
    Boolean(prompt.trim()) &&
    (!isBlueDirect || blueConfigured !== false) &&
    (isParasceneProductAdvanced
      ? Boolean(resolvedBlueModel) && !framesLoading && startFrameIsReady(startFrame)
      : resolvedContinuityMode === "none"
      ? currentIntentId === "text_to_video"
      : !framesLoading &&
        (resolvedContinuityMode === "first_last"
          ? bridgeReady
          : startFrameIsReady(startFrame))) &&
    (resolvedAudioMode === "none" || hasMainAudio);

  const canGenerate =
    isReplicate
      ? fieldsInteractive &&
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

  if (phase === "running" && activeSession && !progressHostedExternally) {
    const running = (
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
    );
    if (embedded) {
      return (
        <div className="add-asset-generate-embedded" aria-busy aria-label="Generating video">
          {running}
        </div>
      );
    }
    return (
      <div
        className="add-asset-generate-pane"
        aria-busy
        aria-label="Generating video"
      >
        {running}
      </div>
    );
  }

  if (
    phase === "error" &&
    (activeSession || draftError) &&
    !progressHostedExternally
  ) {
    const errorText = activeSession?.errorMessage ?? draftError ?? "";
    const canRetryDownload =
      Boolean(clip.addAssetDraft?.replicatePredictionId?.trim()) ||
      isDownloadRetryableError(errorText);
    const errorBody = (
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
    );
    if (embedded) {
      return (
        <div className="add-asset-generate-embedded" role="alert">
          {errorBody}
        </div>
      );
    }
    return (
      <div className="add-asset-generate-pane" role="alert">
        {errorBody}
      </div>
    );
  }

  const showMotionMatch = resolvedContinuityMode === "motion_match";
  const showImagesNone = !isReplicate && currentIntentId === "text_to_video";
  const firstPreview = bridge?.first ?? startFrame;
  const lastPreview = bridge?.last ?? null;

  return (
    <div
      className={
        embedded ? "add-asset-generate-embedded" : "add-asset-generate-pane"
      }
    >
      {embedded ? null : (
        <header className="add-asset-generate-header">
          <div>
            <h2>{serverLabel(currentServer)}</h2>
            <p>{intentLabel(currentIntentId)}</p>
          </div>
        </header>
      )}
      <div
        className={
          embedded ? "add-asset-generate-embedded-body" : "add-asset-generate-body"
        }
      >
        {isBlueDirect ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout" role="note">
              <p className="muted" style={{ margin: 0 }}>
                Direct to Blue — outputs stay local-only (no Creation sync).
                {blueConfigured === false ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => requestOpenSettings()}
                    >
                      Open Settings
                    </button>{" "}
                    to add Blue credentials.
                  </>
                ) : null}
              </p>
            </div>
          </section>
        ) : null}

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
              <button
                type="button"
                className={
                  resolvedContinuityMode !== "motion_match" ? "is-active" : ""
                }
                onClick={() => setContinuityMode(null)}
                aria-pressed={resolvedContinuityMode !== "motion_match"}
              >
                Frames
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
            {blueModelsError ? (
              <p className="add-asset-generate-error">{blueModelsError}</p>
            ) : null}
            {!fieldsInteractive && blueModels == null ? (
              <label className="add-asset-generate-field">
                <span>Blue model</span>
                <select
                  className="control"
                  value={resolvedBlueModel}
                  disabled
                >
                  <option value={resolvedBlueModel}>
                    {resolvedBlueModel}
                  </option>
                </select>
              </label>
            ) : blueModels == null ? (
              <p className="muted">Loading Blue models…</p>
            ) : compatibleBlueModels.length === 0 ? (
              <p className="muted">
                No Blue models for this mode
                {!isBlueDirect
                  ? " (Parascene Creation supports Wan/LTX only — use Direct to Blue for MiniMax and more)."
                  : "."}
              </p>
            ) : (
              <label className="add-asset-generate-field">
                <span>Blue model</span>
                <select
                  className="control"
                  value={resolvedBlueModel}
                  disabled={!fieldsInteractive}
                  onChange={(event) => {
                    const next = event.target.value.trim();
                    if (next) selectBlueModel(next);
                  }}
                >
                  {compatibleBlueModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
        ) : null}

        {!isReplicate && currentIntentId === "text_to_video" ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout" role="note">
              <p className="muted" style={{ margin: 0 }}>
                Text to Video — prompt only, no start image ({resolvedBlueModel}).
              </p>
            </div>
          </section>
        ) : null}

        {isReplicate ? (
          <section className="add-asset-generate-section">
            <h3>Model</h3>
            {replicateModelsError ? (
              <p className="add-asset-generate-error">{replicateModelsError}</p>
            ) : null}
            {!fieldsInteractive && replicateModels == null ? (
              <label className="add-asset-generate-field">
                <span>Enabled model</span>
                <select
                  className="control"
                  value={
                    replicateModelId ??
                    clip.addAssetDraft?.replicateModel ??
                    clip.addAssetGeneration?.model ??
                    ""
                  }
                  disabled
                >
                  <option
                    value={
                      replicateModelId ??
                      clip.addAssetDraft?.replicateModel ??
                      clip.addAssetGeneration?.model ??
                      ""
                    }
                  >
                    {replicateModelId ??
                      clip.addAssetDraft?.replicateModel ??
                      clip.addAssetGeneration?.model ??
                      "—"}
                  </option>
                </select>
              </label>
            ) : replicateModels == null ? (
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
                  disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                    disabled={!fieldsInteractive}
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
                  disabled={!fieldsInteractive}
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
                {resolvedBlueModel}).
              </p>
            </div>
          </section>
        ) : (
        <section className="add-asset-generate-section">
          <h3>{showMotionMatch ? "Character & motion" : "Frames"}</h3>
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
          ) : (
            <div className="add-asset-generate-frame-pair">
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">First</span>
                <FramePreview
                  aspectRatio={aspectRatio}
                  loading={
                    framesLoading &&
                    (frameSourceIsSet(firstFrameSource) ||
                      Boolean(firstPreview?.previewUrl))
                  }
                  loadingLabel="Loading first frame…"
                  preview={
                    firstFrameSource.kind === "none" &&
                    !firstPreview?.previewUrl
                      ? null
                      : firstPreview
                  }
                  emptyLabel={
                    firstFrameSource.kind === "none" &&
                    !firstPreview?.previewUrl
                      ? "None"
                      : firstFrameSource.kind === "asset"
                        ? "Selected image is not available yet."
                        : firstPreview?.previewUrl
                          ? "Start still"
                          : "No previous clip."
                  }
                  alt="First frame"
                />
                <div className="add-asset-generate-frame-slot-actions">
                  <p className="muted add-asset-generate-frame-source-caption">
                    {firstFrameSource.kind === "none" &&
                    firstPreview?.previewUrl
                      ? stampedStartAssetId
                        ? frameSourceCaption(
                            {
                              kind: "asset",
                              assetId: stampedStartAssetId,
                            },
                            "first",
                            imageAssets,
                          )
                        : "Start still"
                      : frameSourceCaption(
                          firstFrameSource,
                          "first",
                          imageAssets,
                        )}
                  </p>
                  {fieldsInteractive ? (
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={framesLoading}
                      onClick={() => setFramePickerSlot("first")}
                    >
                      Choose…
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="add-asset-generate-field add-asset-generate-frame-field">
                <span className="add-asset-generate-frame-caption">Last</span>
                <FramePreview
                  aspectRatio={aspectRatio}
                  loading={
                    framesLoading && frameSourceIsSet(lastFrameSource)
                  }
                  loadingLabel="Loading last frame…"
                  preview={
                    lastFrameSource.kind === "none" ? null : lastPreview
                  }
                  emptyLabel={
                    lastFrameSource.kind === "none"
                      ? "None"
                      : lastFrameSource.kind === "asset"
                        ? "Selected image is not available yet."
                        : "No next clip."
                  }
                  alt="Last frame"
                />
                <div className="add-asset-generate-frame-slot-actions">
                  <p className="muted add-asset-generate-frame-source-caption">
                    {frameSourceCaption(lastFrameSource, "last", imageAssets)}
                  </p>
                  {fieldsInteractive ? (
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={framesLoading}
                      onClick={() => setFramePickerSlot("last")}
                    >
                      Choose…
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        </section>
        )}

        {!isReplicate &&
        (currentIntentId === "image_to_video" ||
          currentIntentId === "image_audio_to_video" ||
          currentIntentId === "text_to_video") ? (
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
                disabled={
                  !fieldsInteractive ||
                  currentIntentId === "text_to_video" ||
                  currentIntentId === "image_audio_to_video"
                }
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
                disabled={
                  !fieldsInteractive ||
                  sourceAudioLocked ||
                  currentIntentId === "text_to_video"
                }
                onClick={() => selectSourceAudio("full_mix")}
                aria-pressed={resolvedAudioMode === "full_mix"}
                title={
                  currentIntentId === "text_to_video"
                    ? "Text to Video has no audio processing"
                    : !hasA2vModels
                      ? "No audio-to-video models available"
                      : !hasMainAudio
                        ? "Add main audio to the timeline first"
                        : undefined
                }
              >
                Full mix
              </button>
              <button
                type="button"
                className={resolvedAudioMode === "vocals" ? "is-active" : ""}
                disabled={
                  !fieldsInteractive ||
                  sourceAudioLocked ||
                  currentIntentId === "text_to_video"
                }
                onClick={() => selectSourceAudio("vocals")}
                aria-pressed={resolvedAudioMode === "vocals"}
                title={
                  currentIntentId === "text_to_video"
                    ? "Text to Video has no audio processing"
                    : !hasA2vModels
                      ? "No audio-to-video models available"
                      : !hasMainAudio
                        ? "Add main audio to the timeline first"
                        : undefined
                }
              >
                Vocals
              </button>
            </div>
            {currentIntentId === "image_audio_to_video" ? (
              <p className="muted add-asset-generate-note">
                Audio to Video requires source audio on the timeline.
              </p>
            ) : null}
          </section>
        ) : null}

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
              disabled={!fieldsInteractive}
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
              disabled={!fieldsInteractive}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={`Describe what happens in these ${clipDurationSec.toFixed(1)} seconds…`}
            />
          </label>
        </section>
      </div>

      <GenerateActions
        onGenerate={handleGenerate}
        onGenerateNew={onGenerateNew}
        generateDisabled={!canGenerate}
        formLocked={formLocked}
        errorRecovery={errorRecovery}
      />

      {framePickerSlot && fieldsInteractive ? (
        <GenerateFrameSourcePicker
          role={framePickerSlot}
          current={
            framePickerSlot === "last" ? lastFrameSource : firstFrameSource
          }
          timelinePreview={pickerTimelinePreview}
          timelineLoading={pickerTimelineLoading}
          assets={imageAssets}
          assetPreviews={assetPreviews}
          timelineAllowed={
            framePickerSlot === "last" ? isReplicate || hasFlfModels : true
          }
          timelineDisallowReason={
            framePickerSlot === "last" && !isReplicate && !hasFlfModels
              ? "No first+last models available for this server."
              : undefined
          }
          onCancel={() => setFramePickerSlot(null)}
          onUse={(source) => {
            if (framePickerSlot === "last") {
              setFrameSources({ last: source });
            } else {
              setFrameSources({ first: source });
            }
            setFramePickerSlot(null);
          }}
        />
      ) : null}
    </div>
  );
}
