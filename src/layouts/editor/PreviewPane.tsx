import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import { AudioWaveform } from "../../library/AudioWaveform";
import {
  clipThumbnailKey,
  ensureClipThumbnail,
  getCachedClipThumbnail,
} from "../../library/clipThumbnail";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import {
  ensureReversedMedia,
  getCachedReversedMedia,
} from "../../library/reversedMedia";
import type { Creation } from "../../library/types";
import {
  PROJECT_ASPECT_OPTIONS,
  type ProjectAspectRatio,
} from "../../project/aspectRatios";
import type { TimelineClip } from "../../project/types";
import { kindFromMediaType } from "./stagingKind";
import { ClipDragHandle, StagingFields } from "./PreviewStaging";
import {
  defaultStagedClipDraft,
  framingClassName,
  framingViewportStyle,
  isProvisionalOutSec,
  normalizeFraming,
  type StagedClipDraft,
  type StagedClipFraming,
} from "./stagedClip";
import { creationCardTitle } from "../../library/creationFlags";
import { TimelineMonitor } from "./TimelineMonitor";
import { useVideoStretchStyle } from "./useVideoStretchStyle";

type PreviewPaneProps = {
  assetId: string | null;
  /** Project creative frame shown as a matte overlay on the asset. */
  aspectRatio: ProjectAspectRatio;
  /** Source asset preview vs timeline-owned monitor. */
  monitorMode?: "source" | "timeline";
  /** Timeline clips for program-monitor compose. */
  timelineClips?: TimelineClip[];
  /** Timeline playhead time when monitorMode is timeline. */
  timelinePlayheadSec?: number;
  /** Whether the timeline clock is advancing. */
  timelinePlaying?: boolean;
  /** Bumps when playhead jumps while playing (scrub / loop) so media re-primes. */
  mediaSeekEpoch?: number;
  /** Staging fields when a timeline clip is selected. */
  stagingSeed?: StagedClipDraft | null;
  /** Clip id (or other key) so re-selecting refreshes seed even for same asset. */
  stagingSeedKey?: string | null;
  /** Persist staging edits onto the selected timeline clip. */
  onClipDraftChange?: (clipId: string, draft: StagedClipDraft) => void;
  /** Show a left-edge control to reopen the assets pane. */
  showAssetsExpand?: boolean;
  onExpandAssets?: () => void;
  /** Shared preview volume (0–100). */
  volume?: number;
  onVolumeChange?: (volume: number) => void;
};

type Size = { w: number; h: number };

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const f = Math.floor((sec % 1) * 24);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

function aspectParts(ratio: ProjectAspectRatio): { w: number; h: number } {
  const opt = PROJECT_ASPECT_OPTIONS.find((o) => o.id === ratio);
  return opt ? { w: opt.w, h: opt.h } : { w: 16, h: 9 };
}

/** Largest box with aspect aw:ah that fits inside maxW×maxH. */
function fitAspect(
  maxW: number,
  maxH: number,
  aw: number,
  ah: number,
): Size {
  if (maxW <= 0 || maxH <= 0 || aw <= 0 || ah <= 0) return { w: 0, h: 0 };
  let w = maxW;
  let h = (w * ah) / aw;
  if (h > maxH) {
    h = maxH;
    w = (h * aw) / ah;
  }
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

function videoAlreadyPainted(el: HTMLVideoElement): boolean {
  return el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function SourceLabelIcon({
  kind,
}: {
  kind: "timeline" | "asset" | "clip" | null;
}) {
  if (kind === "asset") {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
        <rect
          x="2"
          y="3"
          width="12"
          height="10"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <circle cx="5.4" cy="6.4" r="1.1" fill="currentColor" />
        <path d="M2.8 12.4l3-3.4 2 1.9 2.4-2.9 3 4.4z" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "clip") {
    return (
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
        <rect
          x="2"
          y="4"
          width="12"
          height="8"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <path
          d="M6 4v8M10 4v8"
          stroke="currentColor"
          strokeWidth="1.2"
          fill="none"
        />
      </svg>
    );
  }
  // timeline (default)
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <rect
        x="1.8"
        y="3"
        width="12.4"
        height="10"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M1.8 6.4h12.4M5.2 3v3.4M9 6.4v6.6"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

export function PreviewPane({
  assetId,
  aspectRatio,
  monitorMode = "source",
  timelineClips = [],
  timelinePlayheadSec = 0,
  timelinePlaying = false,
  mediaSeekEpoch = 0,
  stagingSeed = null,
  stagingSeedKey = null,
  onClipDraftChange,
  showAssetsExpand = false,
  onExpandAssets,
  volume: volumeProp,
  onVolumeChange,
}: PreviewPaneProps) {
  const [creation, setCreation] = useState<Creation | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentSec, setCurrentSec] = useState(0);
  const [durationSec, setDurationSec] = useState(0);
  const [volumeLocal, setVolumeLocal] = useState(80);
  const volume = volumeProp ?? volumeLocal;
  const setVolume = (next: number) => {
    if (onVolumeChange) onVolumeChange(next);
    else setVolumeLocal(next);
  };
  const [frameSize, setFrameSize] = useState<Size>({ w: 0, h: 0 });
  const [stagedDraft, setStagedDraft] = useState<StagedClipDraft | null>(null);
  const [reversedDetail, setReversedDetail] = useState<string | null>(null);
  const [reversedThumb, setReversedThumb] = useState<string | null>(null);
  const [clipFrameThumb, setClipFrameThumb] = useState<{
    key: string;
    url: string;
  } | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const appliedSeedKeyRef = useRef<string | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const onClipDraftChangeRef = useRef(onClipDraftChange);
  useEffect(() => {
    onClipDraftChangeRef.current = onClipDraftChange;
  }, [onClipDraftChange]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const sync = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const h = Math.max(0, Math.floor(rect.height));
      setFrameSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [loadedAssetId, setLoadedAssetId] = useState(assetId);
  if (assetId !== loadedAssetId) {
    setLoadedAssetId(assetId);
    setPlaying(false);
    setCurrentSec(0);
    setDurationSec(0);
    setCatalogError(false);
    setDetailFailed(false);
    setCreation(null);
  }

  useEffect(() => {
    if (!assetId) return;

    let cancelled = false;

    const load = async () => {
      try {
        const row = await getCreation(assetId);
        if (cancelled) return;
        setCreation(row);
        if (
          !creationDetailUrl(row) &&
          canFetchLocal(row) &&
          !isParasceneUnavailable(row)
        ) {
          void ensureLocal([row.id], { fullMedia: true, urgent: true });
        }
      } catch {
        if (!cancelled) {
          setCreation(null);
          setCatalogError(true);
        }
      }
    };

    void load();

    let unlisten: (() => void) | undefined;
    void listen<Creation>("library-creation-updated", (event) => {
      if (event.payload.id !== assetId) return;
      setCreation(event.payload);
      setCatalogError(false);
      setDetailFailed(false);
    }).then((off) => {
      unlisten = off;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [assetId]);

  const detail = creation ? creationDetailUrl(creation) : null;
  const catalogThumb = creation ? creationPreviewUrl(creation) : null;
  const unavailable = creation ? isParasceneUnavailable(creation) : false;
  const waitingLocal =
    Boolean(creation) &&
    !detail &&
    !catalogThumb &&
    canFetchLocal(creation!) &&
    !unavailable;
  const mediaType = String(creation?.mediaType ?? "")
    .trim()
    .toLowerCase();
  const isVideo = mediaType === "video";
  const isAudio = mediaType === "audio";
  const wantsReverse =
    Boolean(stagedDraft?.reverse) && (isVideo || isAudio);
  const playbackDetail = wantsReverse ? reversedDetail : detail;
  const useDetail = Boolean(playbackDetail) && !detailFailed;
  const canPlay = Boolean(useDetail && (isVideo || isAudio) && !reverseBusy);
  const clipFrameKey =
    stagingSeedKey && stagedDraft?.kind === "video" && assetId
      ? clipThumbnailKey(
          assetId,
          Boolean(stagedDraft.reverse),
          stagedDraft.inSec,
        )
      : null;
  const clipFrameReverse = Boolean(stagedDraft?.reverse);
  const clipFrameInSec = Math.max(0, stagedDraft?.inSec ?? 0);
  const activeClipFrameThumb =
    clipFrameKey && clipFrameThumb?.key === clipFrameKey
      ? clipFrameThumb.url
      : null;
  const thumb =
    activeClipFrameThumb ??
    (wantsReverse && reversedThumb ? reversedThumb : catalogThumb);

  const reverseEnabled = Boolean(wantsReverse && assetId && detail);
  if (!reverseEnabled) {
    if (reversedDetail !== null) setReversedDetail(null);
    if (reversedThumb !== null) setReversedThumb(null);
    if (reverseBusy) setReverseBusy(false);
    if (reverseError !== null) setReverseError(null);
  } else if (assetId) {
    const cachedReverse = getCachedReversedMedia(assetId);
    if (
      cachedReverse &&
      (reversedDetail !== cachedReverse.mediaUrl ||
        reversedThumb !== cachedReverse.thumbUrl)
    ) {
      setReversedDetail(cachedReverse.mediaUrl);
      setReversedThumb(cachedReverse.thumbUrl);
      setReverseBusy(false);
      setReverseError(null);
    }
  }

  useEffect(() => {
    if (!wantsReverse || !assetId || !detail) return;
    if (getCachedReversedMedia(assetId)) return;

    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setReverseBusy(true);
      setReverseError(null);
      setReversedDetail(null);
      setReversedThumb(null);
    });

    void ensureReversedMedia(assetId)
      .then((urls) => {
        if (cancelled) return;
        setReversedDetail(urls.mediaUrl);
        setReversedThumb(urls.thumbUrl);
        setReverseBusy(false);
        setReverseError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Could not reverse media";
        setReverseError(message);
        setReverseBusy(false);
        setReversedDetail(null);
        setReversedThumb(null);
      });

    return () => {
      cancelled = true;
    };
  }, [wantsReverse, assetId, detail, stagingSeedKey]);

  useEffect(() => {
    if (
      !clipFrameKey ||
      !assetId ||
      !playbackDetail
    ) {
      return;
    }
    let cancelled = false;
    const cached = getCachedClipThumbnail(
      assetId,
      clipFrameReverse,
      clipFrameInSec,
    );
    if (cached) {
      void Promise.resolve().then(() => {
        if (!cancelled) setClipFrameThumb({ key: clipFrameKey, url: cached });
      });
    } else {
      void ensureClipThumbnail(assetId, clipFrameReverse, clipFrameInSec)
        .then((url) => {
          if (!cancelled) setClipFrameThumb({ key: clipFrameKey, url });
        })
        .catch(() => {
          // The media element still seeks to the exact in-point; keep the asset
          // thumbnail as a loading fallback if extraction fails.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [
    assetId,
    clipFrameKey,
    clipFrameInSec,
    clipFrameReverse,
    playbackDetail,
  ]);

  if (!assetId || !creation || catalogError) {
    if (stagedDraft !== null) setStagedDraft(null);
  }

  useEffect(() => {
    if (!assetId || !creation || catalogError) {
      appliedSeedKeyRef.current = null;
      return;
    }

    const mt = String(creation.mediaType ?? "image").trim().toLowerCase();
    const kindFromCreation = kindFromMediaType(mt);
    const titled = creationCardTitle(creation);
    const label = titled.untitled
      ? creation.filename?.trim() || assetId
      : titled.text;
    const previewThumb = creationPreviewUrl(creation);
    const reverseThumb =
      stagedDraft?.reverse || stagingSeed?.reverse
        ? reversedThumb ?? getCachedReversedMedia(assetId)?.thumbUrl ?? null
        : null;
    const liveThumb = reverseThumb ?? previewThumb;

    // Ref access marks this effect as post-render coordination for the linter.
    const alreadyApplied = appliedSeedKeyRef.current === stagingSeedKey;

    if (stagingSeedKey && stagingSeed && stagingSeed.assetId === assetId) {
      const nextThumb =
        (stagingSeed.reverse
          ? reverseThumb ?? stagingSeed.thumbUrl
          : previewThumb) ?? stagingSeed.thumbUrl;
      if (alreadyApplied) {
        // Keep in/out/framing edits; prefer reverse thumb when reversed.
        void Promise.resolve().then(() => {
          setStagedDraft((prev) => {
            if (!prev) return prev;
            if (prev.label === label && prev.thumbUrl === nextThumb) return prev;
            return { ...prev, label, thumbUrl: nextThumb };
          });
          if (nextThumb && nextThumb !== stagingSeed.thumbUrl) {
            onClipDraftChangeRef.current?.(stagingSeedKey, {
              ...stagingSeed,
              kind:
                kindFromCreation === "audio"
                  ? "audio"
                  : stagingSeed.kind || kindFromCreation,
              label,
              thumbUrl: nextThumb,
            });
          }
        });
        return;
      }
      appliedSeedKeyRef.current = stagingSeedKey;
      const next = {
        ...stagingSeed,
        kind:
          kindFromCreation === "audio"
            ? "audio"
            : stagingSeed.kind || kindFromCreation,
        label,
        thumbUrl: nextThumb,
      };
      void Promise.resolve().then(() => {
        setStagedDraft(next);
        if (nextThumb && nextThumb !== stagingSeed.thumbUrl) {
          onClipDraftChangeRef.current?.(stagingSeedKey, next);
        }
      });
      return;
    }

    appliedSeedKeyRef.current = null;
    void Promise.resolve().then(() => {
      setStagedDraft((prev) => {
        if (prev?.assetId === assetId) {
          const nextThumb =
            (prev.reverse ? reverseThumb ?? prev.thumbUrl : liveThumb) ??
            prev.thumbUrl;
          if (prev.thumbUrl === nextThumb && prev.label === label) return prev;
          return { ...prev, label, thumbUrl: nextThumb };
        }
        return defaultStagedClipDraft({
          assetId,
          label,
          kind: kindFromCreation,
          sourceDurationSec: durationSec > 0 ? durationSec : undefined,
          thumbUrl: liveThumb,
        });
      });
    });
  }, [
    assetId,
    creation,
    catalogError,
    durationSec,
    stagingSeed,
    stagingSeedKey,
    reversedThumb,
    stagedDraft?.reverse,
  ]);

  function clampInOutDraft(
    draft: StagedClipDraft,
    patch: Partial<Pick<StagedClipDraft, "inSec" | "outSec">>,
    maxSec: number,
  ): StagedClipDraft {
    let inSec = patch.inSec ?? draft.inSec;
    let outSec = patch.outSec ?? draft.outSec;
    inSec = Math.max(0, inSec);
    if (maxSec > 0) {
      inSec = Math.min(inSec, maxSec);
      outSec = Math.min(outSec, maxSec);
    }
    outSec = Math.max(outSec, inSec + 0.1);
    return { ...draft, inSec, outSec };
  }

  if (
    stagedDraft &&
    durationSec > 0 &&
    stagedDraft.kind !== "image" &&
    !stagingSeedKey &&
    isProvisionalOutSec(stagedDraft) &&
    Math.abs(stagedDraft.outSec - durationSec) >= 0.05
  ) {
    setStagedDraft(
      clampInOutDraft(stagedDraft, { outSec: durationSec }, durationSec),
    );
  }

  const [seekSeedKey, setSeekSeedKey] = useState(stagingSeedKey);
  if (stagingSeedKey !== seekSeedKey) {
    setSeekSeedKey(stagingSeedKey);
    if (stagingSeed && stagingSeed.kind !== "image") {
      setCurrentSec(Math.max(0, stagingSeed.inSec));
    }
  }

  // Seek preview to the clip's in-point when loading from the timeline.
  useEffect(() => {
    if (!stagingSeedKey || !stagingSeed) return;
    if (stagingSeed.kind === "image") return;
    const el = mediaRef.current;
    if (!el) return;
    const t = Math.max(0, stagingSeed.inSec);
    try {
      el.currentTime = t;
    } catch {
      // ignore seek before metadata
    }
  }, [stagingSeedKey, stagingSeed, playbackDetail]);

  const editingClip = Boolean(stagingSeedKey);
  const canStage = Boolean(
    assetId && creation && !catalogError && (useDetail || thumb),
  );
  /** Video with Audio Include unticked — mute preview and lock volume. */
  const audioExcluded =
    isVideo && stagedDraft != null && !stagedDraft.includeAudio;
  const volumeEnabled = canPlay && !audioExcluded;
  const sourcePreviewLoops = monitorMode === "source" && (isVideo || isAudio);
  const clipLoopEnabled =
    sourcePreviewLoops &&
    editingClip &&
    stagedDraft != null &&
    stagedDraft.kind !== "image";
  const clipLoopInSec = clipLoopEnabled ? Math.max(0, stagedDraft.inSec) : 0;
  const clipLoopOutSec = clipLoopEnabled
    ? Math.max(clipLoopInSec + 0.1, stagedDraft.outSec)
    : 0;

  // Persistent source-ownership badge for the preview (Timeline / Asset / Clip).
  const assetDisplayName = (() => {
    if (creation) {
      const titled = creationCardTitle(creation);
      if (!titled.untitled) return titled.text;
      return creation.filename?.trim() || assetId || "";
    }
    return stagedDraft?.label || assetId || "";
  })();
  const clipDurationSec = stagedDraft
    ? Math.max(0, stagedDraft.outSec - stagedDraft.inSec)
    : 0;
  const clipTrack = stagedDraft?.kind === "audio" ? "A1" : "V1";
  const mediaFraming: StagedClipFraming =
    stagedDraft && (stagedDraft.kind === "image" || stagedDraft.kind === "video")
      ? normalizeFraming(stagedDraft.framing)
      : "fit";
  const mediaFramingClass = framingClassName(mediaFraming);
  const videoFraming: StagedClipFraming =
    stagedDraft && stagedDraft.kind === "video" ? mediaFraming : "fit";
  const videoStretchStyle = useVideoStretchStyle(
    videoFraming,
    videoRef,
    playbackDetail,
  );
  const sourceKind: "timeline" | "asset" | "clip" | null =
    monitorMode === "timeline"
      ? "timeline"
      : editingClip
        ? "clip"
        : assetId
          ? "asset"
          : null;
  const sourceLabelText =
    sourceKind === "timeline"
      ? "Timeline"
      : sourceKind === "asset"
        ? `Asset • ${assetDisplayName}`
        : sourceKind === "clip"
          ? `Clip • ${clipTrack} • ${clipDurationSec.toFixed(1)}s`
          : null;

  const onStagingDraftChange = (draft: StagedClipDraft) => {
    const next =
      draft.reverse && reversedThumb
        ? { ...draft, thumbUrl: reversedThumb }
        : !draft.reverse && catalogThumb
          ? { ...draft, thumbUrl: catalogThumb }
          : draft;
    setStagedDraft(next);
    if (stagingSeedKey) {
      onClipDraftChange?.(stagingSeedKey, next);
    }
  };

  const playbackResetTarget =
    stagingSeedKey && stagingSeed && stagingSeed.kind !== "image"
      ? Math.max(0, stagingSeed.inSec)
      : 0;
  const [playbackResetKey, setPlaybackResetKey] = useState(
    () => `${assetId ?? ""}:${playbackDetail ?? ""}:${stagingSeedKey ?? ""}`,
  );
  const nextPlaybackResetKey = `${assetId ?? ""}:${playbackDetail ?? ""}:${stagingSeedKey ?? ""}`;
  if (nextPlaybackResetKey !== playbackResetKey) {
    setPlaybackResetKey(nextPlaybackResetKey);
    setPlaying(false);
    setCurrentSec(playbackResetTarget);
    setDurationSec(0);
    setDetailFailed(false);
  }

  useEffect(() => {
    const el = mediaRef.current;
    if (el) {
      el.pause();
      el.currentTime = playbackResetTarget;
    }
  }, [assetId, playbackDetail, playbackResetTarget, stagingSeedKey]);

  const onTogglePlay = () => {
    const el = mediaRef.current;
    if (!el || !canPlay) return;
    if (el.paused) {
      if (
        clipLoopEnabled &&
        (el.currentTime < clipLoopInSec || el.currentTime >= clipLoopOutSec)
      ) {
        el.currentTime = clipLoopInSec;
        setCurrentSec(clipLoopInSec);
      }
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const seekTo = (sec: number) => {
    const el = mediaRef.current;
    if (!el || !canPlay) return;
    const next = Math.max(0, Math.min(el.duration || durationSec, sec));
    el.currentTime = next;
    setCurrentSec(next);
  };

  const onTimeUpdate = (
    event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>,
  ) => {
    const el = event.currentTarget;
    if (clipLoopEnabled && el.currentTime >= clipLoopOutSec - 0.03) {
      el.currentTime = clipLoopInSec;
      setCurrentSec(clipLoopInSec);
      if (!el.paused) void el.play().catch(() => {});
      return;
    }
    setCurrentSec(el.currentTime);
  };

  const onSourceEnded = (
    event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>,
  ) => {
    const el = event.currentTarget;
    if (clipLoopEnabled) {
      el.currentTime = clipLoopInSec;
      setCurrentSec(clipLoopInSec);
      void el.play().catch(() => {
        setPlaying(false);
      });
      return;
    }
    if (sourcePreviewLoops) {
      el.currentTime = 0;
      setCurrentSec(0);
      void el.play().catch(() => {
        setPlaying(false);
      });
      return;
    }
    setPlaying(false);
  };

  const onLoadedMeta = (
    event: SyntheticEvent<HTMLVideoElement | HTMLAudioElement>,
  ) => {
    const d = event.currentTarget.duration;
    setDurationSec(Number.isFinite(d) ? d : 0);
  };

  const bindVideo = (el: HTMLVideoElement | null) => {
    mediaRef.current = el;
    videoRef.current = el;
    if (!el) return;
    el.muted = audioExcluded;
    el.volume = volume / 100;
    if (videoAlreadyPainted(el)) {
      const d = el.duration;
      if (Number.isFinite(d)) setDurationSec(d);
    }
  };

  const bindAudio = (el: HTMLAudioElement | null) => {
    mediaRef.current = el;
    if (!el) return;
    el.muted = false;
    el.volume = volume / 100;
    if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
      const d = el.duration;
      if (Number.isFinite(d)) setDurationSec(d);
    }
  };

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    el.muted = audioExcluded;
    if (!audioExcluded) el.volume = volume / 100;
  }, [audioExcluded, volume]);

  const showAspectOverlay =
    monitorMode === "timeline" || (Boolean(assetId) && !catalogError);
  const stage = fitAspect(frameSize.w, frameSize.h, 16, 9);
  const projectAr = aspectParts(aspectRatio);
  const matte = fitAspect(stage.w, stage.h, projectAr.w, projectAr.h);

  const surfaceStyle: CSSProperties | undefined =
    stage.w > 0 ? { width: stage.w, height: stage.h } : undefined;

  const matteStyle: CSSProperties | undefined =
    matte.w > 0 ? { width: matte.w, height: matte.h } : undefined;

  const sourceViewport = framingViewportStyle(
    mediaFraming,
    stage.w,
    stage.h,
    matte.w,
    matte.h,
  );
  const sourceViewportClass = `editor-preview-framing-viewport${
    sourceViewport ? " is-project-matte" : ""
  }`;

  let status: string | null = null;
  if (monitorMode === "timeline") {
    status = null;
  } else if (!assetId) status = "Select an asset";
  else if (catalogError) status = "Asset not in local catalog";
  else if (!creation) status = "Loading…";
  else if (wantsReverse && reverseBusy) status = "Reversing…";
  else if (wantsReverse && reverseError) status = reverseError;
  else if (wantsReverse && !reversedDetail && detail) status = "Reversing…";
  else if (!useDetail && !thumb && waitingLocal) status = "Saving locally…";
  else if (!useDetail && !thumb) status = "No local media";

  const transportSec = currentSec;
  const transportCanPlay = monitorMode === "source" && canPlay;
  const scrubMax = Math.max(durationSec, 0.1);
  const scrubProgress =
    durationSec > 0
      ? Math.min(100, Math.max(0, (transportSec / durationSec) * 100))
      : 0;

  return (
    <section
      className={`editor-preview-pane${
        showAssetsExpand ? " has-assets-expand" : ""
      }`}
      aria-label="Preview"
    >
      {showAssetsExpand ? (
        <button
          type="button"
          className="editor-pane-expand left"
          onClick={onExpandAssets}
          title="Expand assets"
          aria-label="Expand assets"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path
              fill="currentColor"
              d="M2.2 3.2 6.5 8 2.2 12.8l1.1 1 5.3-5.8L3.3 2.2zm5.2 0L12.7 8l-5.3 4.8 1.1 1L14.8 8 8.5 2.2z"
            />
          </svg>
        </button>
      ) : null}

      <div className="editor-preview-stage">
        <div ref={frameRef} className="editor-preview-frame">
          <div className="editor-preview-surface" style={surfaceStyle}>
            {monitorMode === "timeline" ? (
              <TimelineMonitor
                clips={timelineClips}
                playheadSec={timelinePlayheadSec}
                playing={timelinePlaying}
                mediaSeekEpoch={mediaSeekEpoch}
                volume={volume}
                stageW={stage.w}
                stageH={stage.h}
                matteW={matte.w}
                matteH={matte.h}
              />
            ) : status ? (
              <span className="editor-preview-status muted">{status}</span>
            ) : (
              <>
                <div className={sourceViewportClass} style={sourceViewport}>
                  {/* Thumb stays visible so detail load / cache misses aren't blank. */}
                  {thumb ? (
                    <img
                      key={`thumb:${thumb}`}
                      className={`editor-preview-media editor-preview-thumb ${mediaFramingClass}`}
                      src={thumb}
                      alt=""
                      draggable={false}
                    />
                  ) : null}

                  {useDetail && isVideo ? (
                    <video
                      key={`detail:${playbackDetail}`}
                      ref={bindVideo}
                      className={`editor-preview-media editor-preview-detail ${mediaFramingClass}`}
                      style={videoStretchStyle}
                      src={playbackDetail!}
                      poster={thumb ?? undefined}
                      playsInline
                      preload="auto"
                      loop={sourcePreviewLoops && !clipLoopEnabled}
                      onTimeUpdate={onTimeUpdate}
                      onLoadedMetadata={onLoadedMeta}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onEnded={onSourceEnded}
                      onError={() => setDetailFailed(true)}
                    />
                  ) : null}

                  {useDetail && isAudio ? (
                    <div className="editor-preview-audio">
                      <AudioWaveform className="creation-audio-wave creation-audio-wave-lg editor-preview-audio-icon" />
                      <audio
                        key={`detail:${playbackDetail}`}
                        ref={bindAudio}
                        className="editor-preview-audio-el"
                        src={playbackDetail!}
                        preload="auto"
                        loop={sourcePreviewLoops && !clipLoopEnabled}
                        onTimeUpdate={onTimeUpdate}
                        onLoadedMetadata={onLoadedMeta}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={onSourceEnded}
                        onError={() => setDetailFailed(true)}
                      />
                    </div>
                  ) : null}

                  {useDetail && !isVideo && !isAudio ? (
                    <img
                      key={`detail:${playbackDetail}`}
                      className={`editor-preview-media editor-preview-detail ${mediaFramingClass}`}
                      src={playbackDetail!}
                      alt={creation?.title || "Asset preview"}
                      draggable={false}
                      onError={() => setDetailFailed(true)}
                    />
                  ) : null}
                </div>

                {!useDetail && waitingLocal ? (
                  <span className="editor-preview-wait muted">
                    Saving locally…
                  </span>
                ) : null}
                {!useDetail && wantsReverse && reverseBusy ? (
                  <span className="editor-preview-wait muted">Reversing…</span>
                ) : null}
              </>
            )}

            {showAspectOverlay && matteStyle ? (
              <div className="editor-preview-aspect-overlay" aria-hidden>
                <div className="editor-preview-aspect-matte" style={matteStyle} />
              </div>
            ) : null}
          </div>

          {sourceLabelText ? (
            <div
              className="editor-preview-source-label"
              data-source={sourceKind ?? undefined}
            >
              <SourceLabelIcon kind={sourceKind} />
              <span>{sourceLabelText}</span>
            </div>
          ) : null}
        </div>
        {monitorMode !== "timeline" ? (
        <div className="editor-preview-deck" aria-label="Preview controls">
          <input
            type="range"
            className="editor-transport-scrub"
            min={0}
            max={scrubMax}
            step={0.01}
            value={Math.min(transportSec, scrubMax)}
            disabled={!transportCanPlay}
            aria-label="Seek"
            style={
              {
                ["--scrub-progress" as string]: `${scrubProgress}%`,
              } as CSSProperties
            }
            onChange={(event) => {
              seekTo(Number(event.target.value));
            }}
          />

          <div className="editor-preview-deck-body">
            <div className="editor-preview-deck-row">
              <div className="editor-transport-left">
                <button
                  type="button"
                  className="editor-transport-icon is-play"
                  disabled={!transportCanPlay}
                  title={playing ? "Pause" : "Play"}
                  aria-label={playing ? "Pause" : "Play"}
                  onClick={onTogglePlay}
                >
                  {playing ? (
                    <svg
                      viewBox="0 0 16 16"
                      width="15"
                      height="15"
                      aria-hidden
                    >
                      <path
                        fill="currentColor"
                        d="M4 3h3v10H4zm5 0h3v10H9z"
                      />
                    </svg>
                  ) : (
                    <svg
                      viewBox="0 0 16 16"
                      width="15"
                      height="15"
                      aria-hidden
                    >
                      <path fill="currentColor" d="M4 2.5v11l10-5.5z" />
                    </svg>
                  )}
                </button>
                <span className="editor-transport-tc">
                  {formatClock(transportSec)}
                </span>
              </div>
              <div className="editor-transport-utils">
                {isVideo || isAudio ? (
                  <label
                    className={`editor-transport-volume${
                      volumeEnabled ? "" : " is-disabled"
                    }`}
                  >
                    <svg
                      className="editor-transport-volume-icon"
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      aria-hidden
                    >
                      <path
                        fill="currentColor"
                        d="M2 6h3l3-3v10L5 10H2zm8.2 1.2a2.2 2.2 0 0 1 0 1.6l-.8-.5a1.2 1.2 0 0 0 0-.6zm1.6-2a4.2 4.2 0 0 1 0 5.6l-.8-.5a3.2 3.2 0 0 0 0-4.6z"
                      />
                    </svg>
                    <span className="visually-hidden">Volume</span>
                    <input
                      type="range"
                      className="editor-transport-scrub"
                      min={0}
                      max={100}
                      value={volume}
                      disabled={!volumeEnabled}
                      aria-label="Volume"
                      title={
                        audioExcluded
                          ? "Audio include is off for this clip"
                          : undefined
                      }
                      style={
                        {
                          ["--scrub-progress" as string]: `${volume}%`,
                        } as CSSProperties
                      }
                      onChange={(event) => {
                        if (!volumeEnabled) return;
                        const next = Number(event.target.value);
                        setVolume(next);
                        const el = mediaRef.current;
                        if (el) el.volume = next / 100;
                      }}
                    />
                  </label>
                ) : null}
              </div>
            </div>

            <div className="editor-preview-deck-row">
              {canStage && stagedDraft ? (
                <StagingFields
                  draft={stagedDraft}
                  sourceDurationSec={durationSec}
                  onDraftChange={onStagingDraftChange}
                />
              ) : (
                <p className="muted editor-staging-empty">
                  Select an asset to prepare a clip
                </p>
              )}
              {canStage && stagedDraft && !editingClip ? (
                <ClipDragHandle draft={stagedDraft} />
              ) : null}
            </div>
          </div>
        </div>
        ) : null}
      </div>
    </section>
  );
}
