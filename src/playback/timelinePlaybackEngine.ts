import { timelineSequenceDuration } from "../layouts/editor/timelineCompose";
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

/** Ruler / React playhead updates while playing (engineering gate: not every frame). */
export const PLAYBACK_TIME_UPDATE_HZ = 5;
const TIME_UPDATE_MS = 1000 / PLAYBACK_TIME_UPDATE_HZ;

export type TimelinePlaybackEngineOptions = {
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  /** Throttled while playing; always fired on seek / pause. */
  onTimeUpdate?: (sec: number) => void;
  onPlayingChange?: (playing: boolean) => void;
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
  getCurrentTime(): number;
  isPlaying(): boolean;
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
  };

  let destroyed = false;
  let rafId = 0;
  let lastRafNow = 0;
  let lastEmittedAt = 0;
  /** Playing, but the preview stream has no data at the playhead. Audio holds. */
  let buffering = false;
  let stallFrames = 0;
  let lastVideoSnapAt = 0;
  let hadMonitor = false;

  /** Wrap slack: one frame at the coarsest preview rate (low = 10fps). */
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
  const mse: MseFragmentPlayer = createMseFragmentPlayer(surface);
  let fragmentCache: TimelineFragmentCache | null = null;
  let unsubFragments: (() => void) | null = null;

  let lastMseFeedSec = -1;
  let lastMseFeedAt = 0;

  type ResyncKind = "tick" | "seek" | "transport" | "data";

  const previewStreamActive = () =>
    Boolean(fragmentCache) && timelineMseSupported();

  const resync = (kind: ResyncKind = "data") => {
    if (destroyed) return;
    const cache = fragmentCache;
    const usePreviewStream = previewStreamActive();
    if (usePreviewStream && cache) {
      mse.warm();
      mse.setDuration(state.sequenceDurationSec);
      const nowMs = performance.now();
      const moved = Math.abs(state.currentSec - lastMseFeedSec) >= 0.5;
      // While buffering the playhead is frozen, so movement never re-feeds —
      // retry on a throttle instead (covers transient fetch failures).
      const stalledRetry = buffering && nowMs - lastMseFeedAt > 250;
      const feed = kind !== "tick" || moved || stalledRetry;
      if (feed) {
        lastMseFeedSec = state.currentSec;
        lastMseFeedAt = nowMs;
      }
      mse.sync(state.currentSec, state.playing, cache.readyFragments(), {
        feed,
        seek: kind === "seek",
      });
      mse.show();
      pool.setVisualSuppressed(true);
    } else {
      mse.hide();
      pool.setVisualSuppressed(false);
    }
    // While the preview stream buffers, hold audio too — the picture is the
    // master clock, so nothing else may run ahead of it.
    const effectivePlaying =
      state.playing && !(usePreviewStream && buffering);
    pool.sync(state.clips, state.currentSec, effectivePlaying);
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
    buffering = false;
    stallFrames = 0;
    bumpSeekEpoch();
    resync("seek");
  };

  const tickPreviewStream = (now: number, dt: number) => {
    const end = state.sequenceDurationSec;
    // Audio is the master clock — a light local file that never stalls, and
    // touching a running audio element is always audible. While audio spins up
    // (or there is no bake) the picture leads; a pending seek or buffering
    // holds the playhead where the user put it.
    const pendingSeek = mse.hasPendingSeek();
    const monitor = pool.getMonitorTime();
    if (!pendingSeek && !buffering) {
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
    const covered = mse.covers(state.currentSec, 0.02);
    if (pendingSeek || !covered) {
      stallFrames += 1;
    } else {
      stallFrames = 0;
    }
    // The coarsest preview (low, 10fps) only moves currentTime every ~100ms,
    // so require a real stall (~200ms uncovered) before declaring buffering;
    // pending seeks into unbuffered land are buffering immediately.
    const nextBuffering = pendingSeek || stallFrames > 12;
    if (nextBuffering !== buffering) {
      buffering = nextBuffering;
      if (!buffering) {
        // Resume from where the picture actually stopped so no content is
        // skipped; the epoch bump re-seeks audio to that point.
        const videoTime = mse.getTime();
        if (videoTime > 0) state.currentSec = videoTime;
        hadMonitor = false;
        bumpSeekEpoch();
      }
    }
    // Slave the picture to the clock. Audio is never nudged while running —
    // snap the video instead, which is invisible at preview quality. Right
    // after audio starts (seek latency puts it slightly behind the picture),
    // align tightly once; in steady state only correct real drift.
    let snapVideo = false;
    if (!pendingSeek && !buffering && monitor != null) {
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
        } else {
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
      if (cache) {
        unsubFragments = cache.subscribe(() => {
          resync("data");
        });
      }
      // Seek, not data: the stream may be mid-timeline while the video is at 0.
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
      // Scrub / loop handoff while free-running: re-prime decoders.
      if (state.playing && jumped) bumpSeekEpoch();
      emitTimeUpdate(true);
      resync("seek");
    },
    play() {
      if (destroyed || state.playing) return;
      if (state.sequenceDurationSec <= 0) return;
      state.playing = true;
      // Don't start audio into a black preview — hold until picture exists.
      buffering =
        previewStreamActive() && !mse.covers(state.currentSec, 0.02);
      stallFrames = buffering ? 13 : 0;
      hadMonitor = false;
      options.onPlayingChange?.(true);
      resync("transport");
      startClock();
    },
    pause() {
      if (destroyed || !state.playing) return;
      stopClock();
      state.playing = false;
      buffering = false;
      stallFrames = 0;
      hadMonitor = false;
      options.onPlayingChange?.(false);
      emitTimeUpdate(true);
      resync("transport");
    },
    getCurrentTime() {
      return state.currentSec;
    },
    isPlaying() {
      return state.playing;
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
