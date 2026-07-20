import { useEffect, useRef, useState } from "react";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import type { TimelineClip } from "../../project/types";
import {
  closePreviewSession,
  listenFragmentReady,
  listenPreviewError,
  listenPreviewState,
  openPreviewSession,
  previewPause,
  previewPlay,
  previewReadFragment,
  previewSeek,
  setPreviewTimeline,
  type FragmentReady,
} from "../../preview/previewClient";

type TimelinePreviewPlayerProps = {
  clips: TimelineClip[];
  playheadSec: number;
  playing: boolean;
  mediaSeekEpoch?: number;
  scrubbing?: boolean;
  volume: number;
  aspectRatio: ProjectAspectRatio;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  /** While playing, report the stream clock so the UI follows ONE video. */
  onPlayheadSec?: (sec: number) => void;
};

type QueuedChunk = {
  data: ArrayBuffer;
  /** Set on media fragments; omit for init. */
  timestampOffset?: number;
};

/**
 * Program monitor: ONE persistent <video> fed by the Rust preview session
 * (fMP4 fragments → MSE). Scrub/seek/play are commands to the backend;
 * React only appends bytes and displays the stream.
 */
export function TimelinePreviewPlayer({
  clips,
  playheadSec,
  playing,
  mediaSeekEpoch = 0,
  scrubbing = false,
  volume,
  aspectRatio,
  stageW,
  stageH,
  matteW,
  matteH,
  onPlayheadSec,
}: TimelinePreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const queueRef = useRef<QueuedChunk[]>([]);
  const appendingRef = useRef(false);
  const initAppendedRef = useRef(false);
  const generationRef = useRef(0);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playheadSecRef = useRef(playheadSec);
  const playingRef = useRef(playing);
  const onPlayheadSecRef = useRef(onPlayheadSec);
  const bufferedUntilRef = useRef(0);
  const appendedIdsRef = useRef<Set<string>>(new Set());

  const [status, setStatus] = useState<string | null>("Starting preview…");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    playheadSecRef.current = playheadSec;
  }, [playheadSec]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    onPlayheadSecRef.current = onPlayheadSec;
  }, [onPlayheadSec]);

  const matteLeft = Math.max(0, (stageW - matteW) / 2);
  const matteTop = Math.max(0, (stageH - matteH) / 2);

  function pumpQueue() {
    const sb = sourceBufferRef.current;
    const video = videoRef.current;
    if (!sb || appendingRef.current || sb.updating) return;
    const next = queueRef.current.shift();
    if (!next) return;
    appendingRef.current = true;
    try {
      if (typeof next.timestampOffset === "number") {
        try {
          sb.timestampOffset = next.timestampOffset;
        } catch {
          /* Safari may reject mid-append */
        }
      }
      // Evict media well behind the playhead so long timelines don't QuotaExceeded.
      if (
        video &&
        typeof next.timestampOffset === "number" &&
        video.buffered.length > 0 &&
        video.currentTime > 4
      ) {
        const evictEnd = Math.max(0, video.currentTime - 3);
        try {
          if (video.buffered.start(0) < evictEnd - 0.5) {
            sb.remove(0, evictEnd);
            // remove is async; re-queue and wait for updateend
            queueRef.current.unshift(next);
            return;
          }
        } catch {
          /* ignore evict failures */
        }
      }
      sb.appendBuffer(next.data);
    } catch (e) {
      appendingRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      if (/QuotaExceeded/i.test(msg) && video) {
        try {
          const evictEnd = Math.max(0, video.currentTime - 2);
          appendingRef.current = true;
          sb.remove(0, evictEnd);
          queueRef.current.unshift(next);
          return;
        } catch {
          appendingRef.current = false;
        }
      }
      setError(msg);
    }
  }

  async function resetSourceBuffer(codec: string) {
    const video = videoRef.current;
    if (!video) return;
    queueRef.current = [];
    initAppendedRef.current = false;
    bufferedUntilRef.current = 0;
    appendedIdsRef.current.clear();

    if (mediaSourceRef.current && video.src.startsWith("blob:")) {
      URL.revokeObjectURL(video.src);
    }
    sourceBufferRef.current = null;
    mediaSourceRef.current = null;

    const ms = new MediaSource();
    mediaSourceRef.current = ms;
    video.src = URL.createObjectURL(ms);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ms.removeEventListener("sourceopen", onOpen);
        resolve();
      };
      ms.addEventListener("sourceopen", onOpen);
      ms.addEventListener("error", () => reject(new Error("MediaSource error")), {
        once: true,
      });
    });

    const mime = codec || 'video/mp4; codecs="avc1.4D401F,mp4a.40.2"';
    if (!MediaSource.isTypeSupported(mime)) {
      throw new Error(`MSE type not supported: ${mime}`);
    }
    const sb = ms.addSourceBuffer(mime);
    sb.mode = "segments";
    sb.addEventListener("updateend", () => {
      appendingRef.current = false;
      pumpQueue();
    });
    sb.addEventListener("error", () => {
      setError("SourceBuffer error");
      appendingRef.current = false;
    });
    sourceBufferRef.current = sb;
  }

  function contiguousBufferedEnd(fromSec: number): number {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return 0;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      const end = video.buffered.end(i);
      // Inside this range (small slack for rounding).
      if (fromSec >= start - 0.05 && fromSec < end + 0.05) {
        return end;
      }
    }
    return 0;
  }

  function nextBufferedStart(fromSec: number): number | null {
    const video = videoRef.current;
    if (!video || video.buffered.length === 0) return null;
    let best: number | null = null;
    for (let i = 0; i < video.buffered.length; i++) {
      const start = video.buffered.start(i);
      if (start > fromSec + 0.05) {
        if (best === null || start < best) best = start;
      }
    }
    return best;
  }

  function updateBufferedUntil() {
    const video = videoRef.current;
    if (!video) return;
    bufferedUntilRef.current = contiguousBufferedEnd(video.currentTime);
  }

  async function appendFragment(frag: FragmentReady) {
    if (frag.sessionId !== sessionIdRef.current) return;
    if (frag.generation < generationRef.current) return;
    generationRef.current = Math.max(generationRef.current, frag.generation);

    // Dedupe — backend may re-emit staged fragments while playing.
    if (!frag.reset && appendedIdsRef.current.has(frag.fragmentId)) return;

    try {
      if (frag.reset || !initAppendedRef.current) {
        await resetSourceBuffer(frag.codec);
        if (frag.generation < generationRef.current) return;
        const initBuf = await previewReadFragment(
          frag.sessionId,
          frag.initFile,
          frag.initPath,
        );
        if (frag.generation < generationRef.current) return;
        queueRef.current.push({ data: initBuf });
        initAppendedRef.current = true;
        pumpQueue();
      }

      const mediaBuf = await previewReadFragment(
        frag.sessionId,
        frag.mediaFile,
        frag.mediaPath,
      );
      if (frag.generation < generationRef.current) return;

      queueRef.current.push({
        data: mediaBuf,
        timestampOffset: frag.timelineStart,
      });
      appendedIdsRef.current.add(frag.fragmentId);
      pumpQueue();

      bufferedUntilRef.current = Math.max(
        bufferedUntilRef.current,
        frag.timelineStart + frag.duration,
      );

      const video = videoRef.current;
      const target = playheadSecRef.current;
      if (video && Number.isFinite(target) && !playingRef.current) {
        try {
          if (Math.abs(video.currentTime - target) > 0.04) {
            video.currentTime = target;
          }
        } catch {
          /* ignore */
        }
      }

      // Resume if we stalled waiting for the next second of stream.
      if (playingRef.current && video) {
        updateBufferedUntil();
        if (video.paused && bufferedUntilRef.current > video.currentTime + 0.2) {
          void video.play().catch(() => undefined);
        }
      }

      setStatus(null);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/fragment not found/i.test(msg) || /Load failed/i.test(msg)) {
        setStatus("Seeking…");
        return;
      }
      setError(msg);
    }
  }

  // Open backend preview session once.
  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const videoEl = videoRef.current;

    (async () => {
      try {
        const info = await openPreviewSession();
        if (cancelled) {
          await closePreviewSession(info.sessionId);
          return;
        }
        sessionIdRef.current = info.sessionId;
        setStatus("Warming proxies…");

        unsubs.push(
          await listenFragmentReady((frag) => {
            void appendFragment(frag);
          }),
        );
        unsubs.push(
          await listenPreviewState((st) => {
            if (st.sessionId !== sessionIdRef.current) return;
            generationRef.current = Math.max(
              generationRef.current,
              st.generation,
            );
          }),
        );
        unsubs.push(
          await listenPreviewError((ev) => {
            if (ev.sessionId === sessionIdRef.current) setError(ev.error);
          }),
        );

        await setPreviewTimeline(
          info.sessionId,
          clips,
          aspectRatio,
          playheadSec,
        );
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
      const sid = sessionIdRef.current;
      sessionIdRef.current = null;
      if (sid) void closePreviewSession(sid);
      if (videoEl?.src.startsWith("blob:")) {
        URL.revokeObjectURL(videoEl.src);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session lifecycle once
  }, []);

  // Timeline edits → backend rebuilds the virtual stream.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void setPreviewTimeline(sid, clips, aspectRatio).catch((e) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [clips, aspectRatio]);

  // Scrub / seek → tell the backend where we are in the stream.
  const lastEpochRef = useRef(mediaSeekEpoch);
  const lastSeekSecRef = useRef(playheadSec);
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const epochChanged = lastEpochRef.current !== mediaSeekEpoch;
    lastEpochRef.current = mediaSeekEpoch;

    // While playing, stream clock leads — backend is fed from timeupdate.
    if (playing && !scrubbing && !epochChanged) return;

    const video = videoRef.current;
    if (video && !playing && Number.isFinite(playheadSec)) {
      try {
        if (Math.abs(video.currentTime - playheadSec) > 0.02) {
          video.currentTime = playheadSec;
        }
      } catch {
        /* not seekable yet */
      }
    }

    if (
      !epochChanged &&
      !scrubbing &&
      Math.abs(lastSeekSecRef.current - playheadSec) < 0.04
    ) {
      return;
    }
    lastSeekSecRef.current = playheadSec;

    const mode =
      scrubbing || (!playing && !epochChanged) ? "scrub" : "playback";
    if (seekTimerRef.current) clearTimeout(seekTimerRef.current);
    const delay = mode === "scrub" ? 35 : 0;
    seekTimerRef.current = setTimeout(() => {
      seekTimerRef.current = null;
      void previewSeek(sid, playheadSec, mode).catch(() => undefined);
    }, delay);

    return () => {
      if (seekTimerRef.current) {
        clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, [mediaSeekEpoch, scrubbing, playheadSec, playing]);

  // Play / pause → backend + the single <video>.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (playing) {
      void (async () => {
        await previewPlay(sid);
        // Kick staging at the current stream time, then play when we have headroom.
        await previewSeek(sid, playheadSecRef.current, "playback").catch(
          () => undefined,
        );
        const video = videoRef.current;
        if (!video) return;
        const start = performance.now();
        while (performance.now() - start < 2500) {
          updateBufferedUntil();
          if (bufferedUntilRef.current >= video.currentTime + 1.5) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        if (playingRef.current) {
          void video.play().catch(() => undefined);
        }
      })();
    } else {
      void previewPause(sid);
      videoRef.current?.pause();
    }
  }, [playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  // Stream clock → UI; keep backend playhead + ahead window warm.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playing) return;

    let lastSync = 0;
    let stuckSince: number | null = null;
    let buffering = false;

    const clearBuffering = () => {
      if (buffering) {
        buffering = false;
        setStatus(null);
      }
    };

    const onTime = () => {
      const t = video.currentTime;
      onPlayheadSecRef.current?.(t);
      updateBufferedUntil();
      const contEnd = bufferedUntilRef.current;
      const sid = sessionIdRef.current;
      if (!sid) return;
      const now = performance.now();
      const needBuffer = contEnd < t + 2.5;
      const needSync = now - lastSync > 350;
      if (needBuffer || needSync) {
        lastSync = now;
        void previewSeek(sid, t, "playback").catch(() => undefined);
      }

      const stalled =
        contEnd > 0 ? contEnd - t < 0.2 : video.readyState < 3;
      if (stalled && !video.seeking) {
        if (stuckSince === null) stuckSince = now;
        if (!buffering) {
          buffering = true;
          setStatus("Buffering…");
        }
        // After ~700ms stuck: jump a small hole or force restage ahead.
        if (now - stuckSince > 700) {
          const next = nextBufferedStart(t);
          if (next !== null && next - t < 3) {
            try {
              video.currentTime = next;
              clearBuffering();
              stuckSince = null;
              void video.play().catch(() => undefined);
              return;
            } catch {
              /* ignore */
            }
          }
          // Ask backend for the next second past the contiguous edge.
          void previewSeek(
            sid,
            Math.max(t, contEnd) + 0.05,
            "playback",
          ).catch(() => undefined);
          stuckSince = now; // retry window
        }
      } else {
        stuckSince = null;
        clearBuffering();
      }
    };

    const onWaiting = () => {
      buffering = true;
      setStatus("Buffering…");
      if (stuckSince === null) stuckSince = performance.now();
    };
    const onPlayingEv = () => {
      stuckSince = null;
      clearBuffering();
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlayingEv);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlayingEv);
    };
  }, [playing]);

  return (
    <div
      className="editor-timeline-monitor"
      style={{ width: stageW, height: stageH, position: "relative" }}
    >
      <div
        className="editor-preview-framing-viewport is-project-matte"
        style={{
          position: "absolute",
          left: matteLeft,
          top: matteTop,
          width: matteW > 0 ? matteW : stageW,
          height: matteH > 0 ? matteH : stageH,
          overflow: "hidden",
          background: "#000",
        }}
      >
        <video
          ref={videoRef}
          className="editor-preview-media editor-preview-detail is-framing-fit"
          playsInline
          preload="auto"
          style={{
            position: "absolute",
            left: -matteLeft,
            top: -matteTop,
            width: stageW,
            height: stageH,
            objectFit: "contain",
            background: "#000",
          }}
        />
      </div>
      {(status || error) && (
        <div
          className="editor-preview-status muted"
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 2,
            maxWidth: "90%",
          }}
          role="status"
        >
          {error ? `Preview error: ${error}` : status}
        </div>
      )}
    </div>
  );
}
