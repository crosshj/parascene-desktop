import { timelineSequenceDuration } from "../layouts/editor/timelineCompose";
import type { BakeInfo } from "../library/slideshowMedia";
import type { TimelineClip } from "../project/types";
import {
  createDecoderPool,
  type DecoderPool,
  type PlaybackDiagnostics,
} from "./decoderPool";
import { createMediaSources, type MediaSources } from "./mediaSources";

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

function collectPrewarmIds(clips: readonly TimelineClip[]): {
  assetIds: string[];
  reverseIds: string[];
} {
  const assetIds: string[] = [];
  const reverseIds: string[] = [];
  const seenAsset = new Set<string>();
  const seenReverse = new Set<string>();
  for (const clip of clips) {
    const id = clip.assetId?.trim();
    if (!id) continue;
    if (!seenAsset.has(id)) {
      seenAsset.add(id);
      assetIds.push(id);
    }
    if (
      clip.reverse &&
      clip.kind === "video" &&
      !seenReverse.has(id)
    ) {
      seenReverse.add(id);
      reverseIds.push(id);
    }
  }
  return { assetIds, reverseIds };
}

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

  const resync = () => {
    if (destroyed) return;
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
      const dt = (now - lastRafNow) / 1000;
      lastRafNow = now;
      const end = state.sequenceDurationSec;
      if (end > 0) {
        const advanced = state.currentSec + dt;
        const wrapped = advanced >= end;
        state.currentSec = wrapped ? advanced % end : advanced;
        if (wrapped) bumpSeekEpoch();
        resync();
        emitTimeUpdate(false);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  };

  const unsubSources = mediaSources.subscribe(() => {
    resync();
  });

  return {
    setClips(clips) {
      if (destroyed) return;
      state.clips = clips;
      state.sequenceDurationSec = timelineSequenceDuration(clips);
      const { assetIds, reverseIds } = collectPrewarmIds(clips);
      mediaSources.prewarmAssets(assetIds);
      mediaSources.prewarmReverse(reverseIds);
      resync();
    },
    setBakeInfo(bakeInfoByClipId) {
      if (destroyed) return;
      pool.setBakeInfo(bakeInfoByClipId);
      resync();
    },
    setStage(stageW, stageH, matteW, matteH) {
      if (destroyed) return;
      state.stageW = stageW;
      state.stageH = stageH;
      state.matteW = matteW;
      state.matteH = matteH;
      pool.setStage(stageW, stageH, matteW, matteH);
      resync();
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
      resync();
    },
    seek(sec) {
      if (destroyed) return;
      const next = Math.max(0, sec);
      const jumped = Math.abs(next - state.currentSec) > 1e-4;
      state.currentSec = next;
      // Scrub / loop handoff while free-running: re-prime decoders.
      if (state.playing && jumped) bumpSeekEpoch();
      emitTimeUpdate(true);
      resync();
    },
    play() {
      if (destroyed || state.playing) return;
      if (state.sequenceDurationSec <= 0) return;
      state.playing = true;
      options.onPlayingChange?.(true);
      resync();
      startClock();
    },
    pause() {
      if (destroyed || !state.playing) return;
      stopClock();
      state.playing = false;
      options.onPlayingChange?.(false);
      emitTimeUpdate(true);
      resync();
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
      unsubSources();
      pool.destroy();
      mediaSources.destroy();
      surface.remove();
    },
  };
}
