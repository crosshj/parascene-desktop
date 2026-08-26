import {
  timelineSequenceDuration,
} from "../layouts/editor/timelineCompose";
import {
  FRAGMENT_PLAYBACK_LOOKAHEAD_SEC,
  timelineVideoExtentSec,
} from "../layouts/editor/timelineFragmentPlan";
import type { BakeInfo } from "../library/slideshowMedia";
import type { TimelineFragmentCache } from "../layouts/editor/timelineFragmentCache";
import type { TimelineClip } from "../project/types";
import {
  createDecoderPool,
  type DecoderPool,
  type PlaybackDiagnostics,
} from "./decoderPool";
import { createMediaSources, type MediaSources } from "./mediaSources";
import {
  createMseFragmentPlayer,
  timelineMseSupported,
  type MseFragmentPlayer,
} from "./mseFragmentPlayer";
import { logPreviewEvent } from "./previewDiagnostics";

/** Ruler / React playhead updates while playing (engineering gate: not every frame). */
export const PLAYBACK_TIME_UPDATE_HZ = 5;
const TIME_UPDATE_MS = 1000 / PLAYBACK_TIME_UPDATE_HZ;

export type PreviewPlaybackStatus = {
  /** True while playhead is held waiting for verified picture. */
  holding: boolean;
  phase: "idle" | "loading" | "baking" | "blocked";
  message?: string;
  retryable?: boolean;
};

export type TimelinePlaybackEngineOptions = {
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  /** Throttled while playing; always fired on seek / pause. */
  onTimeUpdate?: (sec: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Preview admission / load state for UI. */
  onPreviewStatusChange?: (status: PreviewPlaybackStatus) => void;
};

export type { PlaybackDiagnostics };

export type TimelinePlaybackEngine = {
  setClips(clips: readonly TimelineClip[]): void;
  setBakeInfo(bakeInfoByClipId: ReadonlyMap<string, BakeInfo> | null): void;
  setAudioBakePath(path: string | null): void;
  setFragmentCache(cache: TimelineFragmentCache | null): void;
  setStage(stageW: number, stageH: number, matteW: number, matteH: number): void;
  setVolume(volume: number): void;
  /** @deprecated Prefer seek() while playing — engine bumps epoch on discontinuities. */
  setMediaSeekEpoch(epoch: number): void;
  seek(sec: number): void;
  play(): void;
  pause(): void;
  retryPreview(): void;
  getCurrentTime(): number;
  isPlaying(): boolean;
  isBuffering(): boolean;
  getPreviewStatus(): PreviewPlaybackStatus;
  getDiagnostics(): PlaybackDiagnostics;
  destroy(): void;
};

type EngineState = {
  clips: readonly TimelineClip[];
  volume: number;
  currentSec: number;
  playing: boolean;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  mediaSeekEpoch: number;
  sequenceDurationSec: number;
  videoExtentSec: number;
};

const IDLE_STATUS: PreviewPlaybackStatus = {
  holding: false,
  phase: "idle",
};

/**
 * Imperative timeline playback core.
 * Owns the playhead RAF while playing; React gets throttled onTimeUpdate.
 */
export function createTimelinePlaybackEngine(
  container: HTMLElement,
  options: TimelinePlaybackEngineOptions,
): TimelinePlaybackEngine {
  const surface = document.createElement("div");
  surface.className = "timeline-playback-engine";
  surface.style.width = "100%";
  surface.style.height = "100%";
  surface.style.position = "relative";
  container.appendChild(surface);

  const state: EngineState = {
    clips: [],
    volume: 100,
    currentSec: 0,
    playing: false,
    stageW: options.stageW,
    stageH: options.stageH,
    matteW: options.matteW,
    matteH: options.matteH,
    mediaSeekEpoch: 0,
    sequenceDurationSec: 0,
    videoExtentSec: 0,
  };

  let destroyed = false;
  let rafId = 0;
  let lastRafNow = 0;
  let lastEmittedAt = 0;
  let buffering = false;
  let stallFrames = 0;
  let lastVideoSnapAt = 0;
  let hadMonitor = false;
  let previewGeneration = 0;
  let previewStatus: PreviewPlaybackStatus = IDLE_STATUS;
  let mseConfigBlocked = false;

  const WRAP_EPSILON_SEC = 0.101;

  const mediaSources: MediaSources = createMediaSources();
  const pool: DecoderPool = createDecoderPool({
    surface,
    mediaSources,
    stageW: state.stageW,
    stageH: state.stageH,
    matteW: state.matteW,
    matteH: state.matteH,
  });

  let fragmentCache: TimelineFragmentCache | null = null;
  let unsubFragments: (() => void) | null = null;

  const bumpPreviewGeneration = (reason: string) => {
    previewGeneration += 1;
    mse.setGeneration(previewGeneration);
    logPreviewEvent({
      ts: Date.now(),
      phase: "generation-bump",
      generation: previewGeneration,
      detail: reason,
    });
  };

  const mse: MseFragmentPlayer = createMseFragmentPlayer(surface, {
    onFetchError: (message) => {
      fragmentCache?.reportError(message);
    },
    onBlocked: (reason) => {
      setPreviewStatus({
        holding: true,
        phase: "blocked",
        message: reason,
        retryable: true,
      });
      setBuffering(true);
    },
  });

  let lastMseFeedSec = -1;

  type ResyncKind = "tick" | "seek" | "transport" | "data";

  const previewStreamActive = () =>
    Boolean(fragmentCache) && timelineMseSupported() && !mseConfigBlocked;

  const needsPreviewCoverage = (sec: number) =>
    previewStreamActive() && sec < state.videoExtentSec - 1e-3;

  const emitPreviewStatus = (next: PreviewPlaybackStatus) => {
    const prev = previewStatus;
    previewStatus = next;
    if (
      prev.holding === next.holding &&
      prev.phase === next.phase &&
      prev.message === next.message
    ) {
      return;
    }
    options.onPreviewStatusChange?.(next);
  };

  const setPreviewStatus = (next: PreviewPlaybackStatus) => {
    emitPreviewStatus(next);
  };

  const refreshPreviewStatus = () => {
    if (mse.getPreviewPhase() === "blocked") {
      setPreviewStatus({
        holding: true,
        phase: "blocked",
        message: mse.getBlockedReason() ?? "Preview blocked",
        retryable: true,
      });
      return;
    }
    if (!needsPreviewCoverage(state.currentSec)) {
      setPreviewStatus(IDLE_STATUS);
      return;
    }
    const cache = fragmentCache;
    if (!cache) {
      setPreviewStatus(IDLE_STATUS);
      return;
    }
    const covering = cache.fragmentCovering(state.currentSec);
    if (!covering) {
      const fragStatus = cache.status();
      setPreviewStatus({
        holding: buffering,
        phase: fragStatus.baking ? "baking" : "loading",
        message: fragStatus.baking
          ? `Baking preview… ${fragStatus.ready}/${fragStatus.total}`
          : "Loading preview…",
      });
      return;
    }
    if (!mse.coversRangeExact(covering.startSec, covering.startSec + covering.durationSec)) {
      setPreviewStatus({
        holding: buffering,
        phase: "loading",
        message: "Loading preview…",
      });
      return;
    }
    if (!ensurePlayableWindow(state.currentSec)) {
      setPreviewStatus({
        holding: buffering,
        phase: "loading",
        message: "Loading preview…",
      });
      return;
    }
    setPreviewStatus(IDLE_STATUS);
  };

  const setBuffering = (next: boolean) => {
    if (buffering === next) return;
    buffering = next;
    refreshPreviewStatus();
  };

  /**
   * Covering fragment and next (when within lookahead) verified in SourceBuffer.
   * Last picture fragment needs no next.
   */
  const ensurePlayableWindow = (sec: number): boolean => {
    if (!needsPreviewCoverage(sec)) return true;
    const cache = fragmentCache;
    if (!cache) return false;

    const covering = cache.fragmentCovering(sec);
    if (!covering) return false;
    const coverEnd = covering.startSec + covering.durationSec;
    if (!mse.coversRangeExact(covering.startSec, coverEnd)) return false;

    const nextStart = coverEnd;
    if (nextStart >= state.videoExtentSec - 1e-3) return true;

    const lookahead = FRAGMENT_PLAYBACK_LOOKAHEAD_SEC;
    if (nextStart - sec > lookahead + 1e-3) return true;

    const next = cache.fragmentCovering(nextStart);
    if (!next) return false;
    const nextEnd = next.startSec + next.durationSec;
    return mse.coversRangeExact(next.startSec, nextEnd);
  };

  const resync = (kind: ResyncKind = "data") => {
    if (destroyed) return;
    const cache = fragmentCache;
    const usePreviewStream = previewStreamActive();
    const inVideoRegion = state.currentSec < state.videoExtentSec - 1e-3;

    if (fragmentCache && !timelineMseSupported()) {
      mseConfigBlocked = true;
      mse.hide();
      pool.setVisualSuppressed(true);
      setPreviewStatus({
        holding: true,
        phase: "blocked",
        message: "Preview requires MSE — codec not supported in this WebView.",
        retryable: false,
      });
      setBuffering(true);
      pool.sync(state.clips, state.currentSec, false);
      return;
    }

    if (usePreviewStream && cache && inVideoRegion) {
      mse.warm();
      mse.setDuration(Math.max(state.videoExtentSec, 0.1));
      const moved = Math.abs(state.currentSec - lastMseFeedSec) >= 0.5;
      const ticketRetry = mse.getPreviewPhase() === "loading";
      const feed = kind !== "tick" || moved || ticketRetry || buffering;
      if (feed) {
        lastMseFeedSec = state.currentSec;
      }
      mse.sync(state.currentSec, state.playing, cache.readyFragments(), {
        feed,
        seek: kind === "seek",
      });
      mse.show();
      pool.setVisualSuppressed(true);
    } else if (usePreviewStream && cache && !inVideoRegion) {
      mse.hide();
      pool.setVisualSuppressed(true);
    } else if (fragmentCache) {
      mse.hide();
      pool.setVisualSuppressed(true);
    } else {
      mse.hide();
      pool.setVisualSuppressed(false);
    }

    const effectivePlaying =
      state.playing && !(needsPreviewCoverage(state.currentSec) && buffering);
    pool.sync(state.clips, state.currentSec, effectivePlaying);
    refreshPreviewStatus();
  };

  const bumpSeekEpoch = () => {
    state.mediaSeekEpoch += 1;
    pool.setMediaSeekEpoch(state.mediaSeekEpoch);
  };

  const emitTimeUpdate = (force: boolean) => {
    const now = performance.now();
    if (!force && now - lastEmittedAt < TIME_UPDATE_MS) return;
    lastEmittedAt = now;
    options.onTimeUpdate?.(state.currentSec);
  };

  const stopClock = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  const wrapToStart = () => {
    state.currentSec = 0;
    setBuffering(false);
    stallFrames = 0;
    bumpSeekEpoch();
    resync("seek");
  };

  const tickPreviewStream = (now: number, dt: number) => {
    const end = state.sequenceDurationSec;
    const inVideoRegion = state.currentSec < state.videoExtentSec - 1e-3;

    if (mse.getPreviewPhase() === "blocked") {
      setBuffering(true);
      return;
    }

    if (!inVideoRegion) {
      if (buffering) setBuffering(false);
      stallFrames = 0;
      const monitor = pool.getMonitorTime();
      if (monitor != null) {
        state.currentSec = monitor;
      } else {
        state.currentSec += dt;
      }
      if (state.currentSec >= end - WRAP_EPSILON_SEC) {
        hadMonitor = false;
        wrapToStart();
        return;
      }
      resync("tick");
      return;
    }

    const pendingSeek = mse.hasPendingSeek();
    const monitor = pool.getMonitorTime();
    const playable = ensurePlayableWindow(state.currentSec);

    if (!pendingSeek && !buffering && playable) {
      if (monitor != null) {
        state.currentSec = monitor;
      } else {
        const videoTime = mse.getTime();
        state.currentSec = videoTime > 0 ? videoTime : state.currentSec + dt;
      }
    }

    if (mse.isEnded() || state.currentSec >= end - WRAP_EPSILON_SEC) {
      hadMonitor = false;
      wrapToStart();
      return;
    }

    const covered = mse.covers(state.currentSec, FRAGMENT_PLAYBACK_LOOKAHEAD_SEC);
    if (pendingSeek || !playable || !covered) {
      stallFrames += 1;
    } else {
      stallFrames = 0;
    }

    const nextBuffering = pendingSeek || !playable || (!covered && stallFrames > 12);
    if (nextBuffering !== buffering) {
      setBuffering(nextBuffering);
      if (!buffering) {
        const videoTime = mse.getTime();
        if (videoTime > 0) state.currentSec = videoTime;
        hadMonitor = false;
        bumpSeekEpoch();
      }
    }

    let snapVideo = false;
    if (!pendingSeek && !buffering && playable && monitor != null) {
      const drift = Math.abs(mse.getTime() - state.currentSec);
      const limit = hadMonitor ? 0.35 : 0.12;
      if (drift > limit && covered && now - lastVideoSnapAt > 500) {
        lastVideoSnapAt = now;
        snapVideo = true;
      }
      hadMonitor = true;
    } else if (monitor == null) {
      hadMonitor = false;
    }
    resync(snapVideo ? "seek" : "tick");
  };

  const tickLegacy = (dt: number) => {
    const end = state.sequenceDurationSec;
    const monitor = pool.getMonitorTime();
    if (monitor != null) {
      state.currentSec = monitor;
    } else {
      state.currentSec += dt;
    }
    if (state.currentSec >= end) {
      state.currentSec = state.currentSec % end;
      bumpSeekEpoch();
      resync("seek");
    } else {
      resync("tick");
    }
  };

  const startClock = () => {
    stopClock();
    lastRafNow = performance.now();
    const tick = (now: number) => {
      if (destroyed || !state.playing) {
        rafId = 0;
        return;
      }
      const dt = Math.max(0, (now - lastRafNow) / 1000);
      lastRafNow = now;
      const end = state.sequenceDurationSec;
      if (end > 0) {
        if (previewStreamActive()) {
          tickPreviewStream(now, dt);
        } else if (!fragmentCache) {
          tickLegacy(dt);
        }
        emitTimeUpdate(false);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const unsubSources = mediaSources.subscribe(() => {
    resync("data");
  });

  return {
    setClips(clips) {
      if (destroyed) return;
      state.clips = clips;
      state.sequenceDurationSec = timelineSequenceDuration(clips);
      state.videoExtentSec = timelineVideoExtentSec(clips);
      bumpPreviewGeneration("clips");
      resync("data");
    },
    setBakeInfo(bakeInfoByClipId) {
      if (destroyed) return;
      pool.setBakeInfo(bakeInfoByClipId);
      resync("data");
    },
    setAudioBakePath(path) {
      if (destroyed) return;
      pool.setAudioBakePath(path);
      resync("data");
    },
    setFragmentCache(cache) {
      if (destroyed) return;
      unsubFragments?.();
      unsubFragments = null;
      fragmentCache = cache;
      mseConfigBlocked = false;
      if (cache) {
        bumpPreviewGeneration("fragment-cache");
        unsubFragments = cache.subscribe(() => {
          resync("data");
          if (
            state.playing &&
            buffering &&
            needsPreviewCoverage(state.currentSec) &&
            ensurePlayableWindow(state.currentSec)
          ) {
            stallFrames = Math.min(stallFrames, 6);
          }
        });
      }
      resync("seek");
    },
    setStage(stageW, stageH, matteW, matteH) {
      if (destroyed) return;
      state.stageW = stageW;
      state.stageH = stageH;
      state.matteW = matteW;
      state.matteH = matteH;
      pool.setStage(stageW, stageH, matteW, matteH);
      resync("data");
    },
    setVolume(volume) {
      if (destroyed) return;
      state.volume = Math.max(0, Math.min(100, volume));
      pool.setVolume(state.volume);
    },
    setMediaSeekEpoch(epoch) {
      if (destroyed) return;
      state.mediaSeekEpoch = epoch;
      pool.setMediaSeekEpoch(epoch);
      resync("seek");
    },
    seek(sec) {
      if (destroyed) return;
      const next = Math.max(0, sec);
      const jumped = Math.abs(next - state.currentSec) > 1e-4;
      state.currentSec = next;
      stallFrames = 0;
      if (state.playing && jumped) bumpSeekEpoch();
      fragmentCache?.demandPlayableWindow(next);
      const hold =
        needsPreviewCoverage(next) && !ensurePlayableWindow(next);
      setBuffering(hold);
      stallFrames = hold ? 13 : 0;
      emitTimeUpdate(true);
      resync("seek");
    },
    play() {
      if (destroyed || state.playing) return;
      if (state.sequenceDurationSec <= 0) return;
      state.playing = true;
      fragmentCache?.demandPlayableWindow(state.currentSec);
      const hold =
        needsPreviewCoverage(state.currentSec) &&
        !ensurePlayableWindow(state.currentSec);
      setBuffering(hold);
      stallFrames = hold ? 13 : 0;
      hadMonitor = false;
      options.onPlayingChange?.(true);
      resync("transport");
      startClock();
    },
    pause() {
      if (destroyed || !state.playing) return;
      stopClock();
      state.playing = false;
      setBuffering(false);
      stallFrames = 0;
      hadMonitor = false;
      options.onPlayingChange?.(false);
      emitTimeUpdate(true);
      resync("transport");
    },
    retryPreview() {
      if (destroyed) return;
      mse.retryBlocked();
      bumpPreviewGeneration("retry");
      setBuffering(true);
      stallFrames = 13;
      resync("data");
    },
    getCurrentTime() {
      return state.currentSec;
    },
    isPlaying() {
      return state.playing;
    },
    isBuffering() {
      return buffering;
    },
    getPreviewStatus() {
      return previewStatus;
    },
    getDiagnostics() {
      return pool.getDiagnostics();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      state.playing = false;
      stopClock();
      unsubFragments?.();
      unsubFragments = null;
      fragmentCache = null;
      unsubSources();
      mse.destroy();
      pool.destroy();
      mediaSources.destroy();
      surface.remove();
    },
  };
}
