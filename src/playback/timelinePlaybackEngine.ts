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
  /** Once a chunk is on screen while playing, stay on MSE so cuts don't flash. */
  let mseHeld = false;

  type ResyncKind = "tick" | "seek" | "transport" | "data";

  const resync = (kind: ResyncKind = "data") => {
    if (destroyed) return;
    const cache = fragmentCache;
    const canMse = Boolean(cache) && timelineMseSupported();
    if (canMse && cache) {
      mse.warm();
      mse.setDuration(state.sequenceDurationSec);
      const moved = Math.abs(state.currentSec - lastMseFeedSec) >= 0.5;
      const feed = kind !== "tick" || moved;
      if (feed) lastMseFeedSec = state.currentSec;
      mse.sync(state.currentSec, state.playing, cache.readyFragments(), {
        feed,
        seek: kind === "seek" || !state.playing,
      });
    }

    const hasFrame = canMse && mse.covers(state.currentSec, 0);
    if (state.playing && hasFrame) mseHeld = true;
    if (!state.playing) mseHeld = false;
    const showMse = canMse && (hasFrame || (state.playing && mseHeld));

    if (showMse) {
      mse.show();
      pool.setVisualSuppressed(true);
    } else {
      mse.hide();
      pool.setVisualSuppressed(false);
    }
    pool.sync(state.clips, state.currentSec, state.playing);
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
        // Picture is MSE only. Clock follows baked audio when it is running
        // so a waiting SourceBuffer cannot freeze the playhead.
        const monitor = pool.getMonitorTime();
        if (monitor != null) {
          state.currentSec = monitor;
        } else {
          state.currentSec += dt;
        }
        const wrapped = state.currentSec >= end;
        if (wrapped) {
          state.currentSec = state.currentSec % end;
          bumpSeekEpoch();
          resync("seek");
        } else {
          resync("tick");
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
      resync("data");
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
      // Scrub / loop handoff while free-running: re-prime decoders.
      if (state.playing && jumped) bumpSeekEpoch();
      emitTimeUpdate(true);
      resync("seek");
    },
    play() {
      if (destroyed || state.playing) return;
      if (state.sequenceDurationSec <= 0) return;
      state.playing = true;
      options.onPlayingChange?.(true);
      resync("transport");
      startClock();
    },
    pause() {
      if (destroyed || !state.playing) return;
      stopClock();
      state.playing = false;
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
