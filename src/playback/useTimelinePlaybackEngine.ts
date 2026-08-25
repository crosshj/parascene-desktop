import {
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";
import type { BakeInfo } from "../library/slideshowMedia";
import type { TimelineFragmentCache } from "../layouts/editor/timelineFragmentCache";
import type { TimelineClip } from "../project/types";
import {
  createTimelinePlaybackEngine,
  type TimelinePlaybackEngine,
} from "./timelinePlaybackEngine";

export type TimelinePlaybackEngineHostProps = {
  clips: TimelineClip[];
  /** Authoritative while paused / for scrub seeks. */
  playheadSec: number;
  playing: boolean;
  /**
   * Bumped by the editor on scrub-while-playing so the host applies playheadSec
   * even though the engine owns the clock while playing.
   */
  mediaSeekEpoch?: number;
  bakeInfoByClipId?: ReadonlyMap<string, BakeInfo>;
  /** Cached timeline mix; when set, monitor plays this instead of live clip audio. */
  audioBakePath?: string | null;
  /** Replaceable fMP4 preview fragments for MSE playback. */
  fragmentCache?: TimelineFragmentCache | null;
  volume: number;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  /** Throttled while playing; immediate on seek / pause. */
  onTimeUpdate?: (sec: number) => void;
};

/**
 * Mounts the imperative playback engine on `containerRef` and mirrors React props.
 * While playing the engine owns the playhead RAF; `playheadSec` is applied only
 * when paused or when `mediaSeekEpoch` bumps (scrub).
 */
export function useTimelinePlaybackEngine(
  containerRef: RefObject<HTMLElement | null>,
  {
    clips,
    playheadSec,
    playing,
    mediaSeekEpoch = 0,
    bakeInfoByClipId,
    audioBakePath = null,
    fragmentCache = null,
    volume,
    stageW,
    stageH,
    matteW,
    matteH,
    onTimeUpdate,
  }: TimelinePlaybackEngineHostProps,
): void {
  const engineRef = useRef<TimelinePlaybackEngine | null>(null);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  const playheadSecRef = useRef(playheadSec);
  const wasPlayingRef = useRef(playing);
  // Keep latest callbacks/values for effects without re-subscribing the engine.
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value mirror
  onTimeUpdateRef.current = onTimeUpdate;
  // eslint-disable-next-line react-hooks/refs -- intentional latest-value mirror
  playheadSecRef.current = playheadSec;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const engine = createTimelinePlaybackEngine(el, {
      stageW,
      stageH,
      matteW,
      matteH,
      onTimeUpdate: (sec) => onTimeUpdateRef.current?.(sec),
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // Mount once; stage/clips sync via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  useEffect(() => {
    engineRef.current?.setStage(stageW, stageH, matteW, matteH);
  }, [stageW, stageH, matteW, matteH]);

  useEffect(() => {
    engineRef.current?.setClips(clips);
  }, [clips]);

  useEffect(() => {
    engineRef.current?.setBakeInfo(bakeInfoByClipId ?? null);
  }, [bakeInfoByClipId]);

  useEffect(() => {
    engineRef.current?.setAudioBakePath(audioBakePath ?? null);
  }, [audioBakePath]);

  useEffect(() => {
    engineRef.current?.setFragmentCache(fragmentCache ?? null);
  }, [fragmentCache]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  // Play / pause — layout so pause emits final time before parent persist effects.
  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (playing) engine.play();
    else engine.pause();
  }, [playing]);

  // Paused scrub / seek: React playhead is authoritative.
  // Skip the play→pause transition — engine.pause() already holds the true time.
  useEffect(() => {
    const wasPlaying = wasPlayingRef.current;
    wasPlayingRef.current = playing;
    if (playing) return;
    if (wasPlaying) return;
    engineRef.current?.seek(playheadSec);
  }, [playheadSec, playing]);

  // Scrub while playing: apply the latest playhead without chasing RAF ticks.
  useEffect(() => {
    if (!playing) return;
    engineRef.current?.seek(playheadSecRef.current);
  }, [mediaSeekEpoch, playing]);
}
