import { mediaUrlForBakePath } from "../library/slideshowMedia";
import {
  fmp4HasMediaFragment,
  formatTrackRange,
  inspectFragmentTimestamps,
  splitFmp4,
} from "./fmp4Boxes";
import {
  bufferedIsContinuous,
  formatBufferedRanges,
  timeRangesToArray,
} from "./bufferedRanges";

/** Baseline level 3.1 — matches the encoder and covers the High (960x540) preview. */
export const TIMELINE_MSE_MIME = 'video/mp4; codecs="avc1.42E01F"';

export const MSE_BUFFER_AHEAD_SEC = 8;
export const MSE_BUFFER_BEHIND_SEC = 2;
/** Paused scrub keeps a wider cached window so random seeks land on a frame. */
export const MSE_SCRUB_WINDOW_SEC = 12;

export type ReadyTimelineFragment = {
  index: number;
  startSec: number;
  durationSec: number;
  fingerprint: string;
  path: string;
};

export function timelineMseSupported(): boolean {
  if (typeof MediaSource === "undefined") return false;
  try {
    return MediaSource.isTypeSupported(TIMELINE_MSE_MIME);
  } catch {
    return false;
  }
}

type BufferOp =
  | {
      kind: "append";
      fragment: ReadyTimelineFragment;
      bytes: Uint8Array;
      retried?: boolean;
    }
  | { kind: "remove"; start: number; end: number }
  | { kind: "duration"; sec: number };

export type MseSyncOpts = {
  /** Append/remove fragments for the playhead window. Default true. */
  feed?: boolean;
  /**
   * Authoritative seek to currentSec. If the target is not buffered yet it
   * stays pending and is applied on the first append that covers it.
   */
  seek?: boolean;
};

export type MseFragmentPlayer = {
  readonly video: HTMLVideoElement;
  setDuration(sec: number): void;
  sync(
    currentSec: number,
    playing: boolean,
    fragments: readonly ReadyTimelineFragment[],
    opts?: MseSyncOpts,
  ): void;
  /** Video element's clock — the master clock while the preview stream plays. */
  getTime(): number;
  /** True while a seek is waiting for its target range to be buffered. */
  hasPendingSeek(): boolean;
  isEnded(): boolean;
  /** Attach MediaSource and fetch/append without showing the element. */
  warm(): void;
  show(): void;
  hide(): void;
  isActive(): boolean;
  /** True when `sec` is inside a buffered range with `aheadSec` of future data. */
  covers(sec: number, aheadSec?: number): boolean;
  destroy(): void;
};

type AppendedRec = {
  fingerprint: string;
  start: number;
  end: number;
};

/**
 * One HTMLVideoElement + one SourceBuffer. Fragments are CMAF media segments
 * on a shared timeline (tfdt carries the position; timestampOffset stays 0).
 * While playing, the element free-runs and IS the clock; the engine reads
 * getTime(). Seeks are pending-until-buffered so they are never lost.
 */
export function createMseFragmentPlayer(surface: HTMLElement): MseFragmentPlayer {
  const video = document.createElement("video");
  video.className = "editor-preview-media timeline-mse-video";
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.display = "none";

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let objectUrl: string | null = null;
  let destroyed = false;
  let warmed = false;
  let visible = false;
  let durationSec = 0;
  let initAppended = false;
  /** Timeline position the caller wants; applied once its range is buffered. */
  let pendingSeekSec: number | null = null;
  /** Transport intent. The element may still be waiting for data. */
  let wantPlaying = false;
  /** An unresolved play() promise exists — do not stack another. */
  let playPending = false;
  /** Last feed window, for quota-pressure trims. */
  let lastWindow = { start: 0, end: MSE_BUFFER_AHEAD_SEC };
  const appended = new Map<number, AppendedRec>();
  const inflightFetch = new Map<string, Promise<Uint8Array | null>>();
  const queue: BufferOp[] = [];
  let pumping = false;
  let pendingMark: {
    index: number;
    fingerprint: string;
    start: number;
    end: number;
  } | null = null;

  const coversRange = (sec: number, aheadSec = 0): boolean => {
    const need =
      durationSec > 0
        ? Math.min(sec + Math.max(0, aheadSec), Math.max(0, durationSec - 0.01))
        : sec + Math.max(0, aheadSec);
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges.start(i) <= sec + 0.05 && ranges.end(i) >= need) {
        return true;
      }
    }
    return false;
  };

  const ensurePlayback = () => {
    if (destroyed) return;
    if (!wantPlaying) {
      playPending = false;
      if (!video.paused) video.pause();
      return;
    }
    // Do not roll from a stale position while a seek waits for data.
    if (pendingSeekSec != null && !coversRange(pendingSeekSec, 0)) return;
    if (video.paused && !playPending) {
      playPending = true;
      video.muted = true;
      const promise = video.play();
      if (promise) {
        promise.then(
          () => {
            playPending = false;
          },
          () => {
            playPending = false;
          },
        );
      } else {
        playPending = false;
      }
    }
  };

  const tryApplyPendingSeek = () => {
    if (destroyed || pendingSeekSec == null) return;
    const target = pendingSeekSec;
    if (!coversRange(target, 0)) return;
    pendingSeekSec = null;
    try {
      if (Math.abs((video.currentTime || 0) - target) > 0.001) {
        video.currentTime = target;
      }
    } catch {
      /* ignore */
    }
    ensurePlayback();
  };

  const logAppend = (mark: NonNullable<typeof pendingMark>, bytes: Uint8Array) => {
    const report = inspectFragmentTimestamps(bytes);
    const buffered = timeRangesToArray(video.buffered);
    console.info(`[timeline-mse] append fragment ${mark.index}`);
    console.info(`  video ${formatTrackRange(report.video)}`);
    if (report.audio) {
      console.info(`  audio ${formatTrackRange(report.audio)}`);
    } else {
      console.info("  audio none in fragment (separate baked stream)");
    }
    console.info(
      `[timeline-mse] SourceBuffer.buffered ${formatBufferedRanges(buffered)}`,
    );
    const settled =
      queue.every((op) => op.kind !== "append") && inflightFetch.size === 0;
    if (!bufferedIsContinuous(buffered) && settled) {
      console.warn(
        "[timeline-mse] GAPS — sequential cached fragments must produce one continuous range, e.g. [0.000, 8.000]",
      );
    }
  };

  /** Bytes of the op currently being appended, for diagnostics. */
  let appendingBytes: Uint8Array | null = null;

  const resetMedia = () => {
    initAppended = false;
    pendingMark = null;
    appendingBytes = null;
    pendingSeekSec = null;
    playPending = false;
    appended.clear();
    queue.length = 0;
    sourceBuffer = null;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    if (mediaSource) {
      try {
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
      mediaSource = null;
    }
    video.removeAttribute("src");
    video.load();
  };

  const attach = () => {
    if (destroyed || mediaSource) return;
    if (!timelineMseSupported()) return;
    mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;
    mediaSource.addEventListener("sourceopen", () => {
      if (destroyed || !mediaSource || sourceBuffer) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(TIMELINE_MSE_MIME);
        sourceBuffer.mode = "segments";
        sourceBuffer.addEventListener("updateend", () => {
          if (pendingMark) {
            appended.set(pendingMark.index, {
              fingerprint: pendingMark.fingerprint,
              start: pendingMark.start,
              end: pendingMark.end,
            });
            if (appendingBytes) logAppend(pendingMark, appendingBytes);
            pendingMark = null;
            appendingBytes = null;
          }
          pumping = false;
          tryApplyPendingSeek();
          ensurePlayback();
          void pump();
        });
        sourceBuffer.addEventListener("error", () => {
          pendingMark = null;
          appendingBytes = null;
          pumping = false;
          void pump();
        });
        if (durationSec > 0) {
          try {
            mediaSource.duration = durationSec;
          } catch {
            /* ignore */
          }
        }
        void pump();
      } catch {
        sourceBuffer = null;
      }
    });
  };

  const enqueue = (op: BufferOp) => {
    if (destroyed) return;
    queue.push(op);
    void pump();
  };

  /** Drop appended fragments outside the keep window (and their media). */
  const trimOutside = (keepFrom: number, keepTo: number) => {
    for (const [index, rec] of [...appended]) {
      if (rec.end <= keepFrom || rec.start >= keepTo) {
        appended.delete(index);
        enqueue({ kind: "remove", start: rec.start, end: rec.end });
      }
    }
  };

  const pump = () => {
    if (destroyed || pumping) return;
    if (!sourceBuffer || sourceBuffer.updating) return;
    if (mediaSource?.readyState !== "open") return;
    const op = queue.shift();
    if (!op) return;
    pumping = true;
    try {
      if (op.kind === "duration") {
        try {
          mediaSource.duration = op.sec;
        } catch {
          /* ignore */
        }
        pumping = false;
        void pump();
        return;
      }
      if (op.kind === "remove") {
        const end = Math.max(op.start + 0.001, op.end);
        sourceBuffer.remove(op.start, end);
        return;
      }
      const { init, media } = splitFmp4(op.bytes);
      if (!initAppended) {
        if (init.byteLength === 0) {
          pumping = false;
          void pump();
          return;
        }
        initAppended = true;
        queue.unshift(op);
        sourceBuffer.timestampOffset = 0;
        sourceBuffer.appendBuffer(init.slice().buffer);
        return;
      }
      if (media.byteLength === 0) {
        pumping = false;
        void pump();
        return;
      }
      // Queued twice before the first append settled — skip the duplicate.
      if (
        appended.get(op.fragment.index)?.fingerprint === op.fragment.fingerprint
      ) {
        pumping = false;
        void pump();
        return;
      }
      pendingMark = {
        index: op.fragment.index,
        fingerprint: op.fragment.fingerprint,
        start: op.fragment.startSec,
        end: op.fragment.startSec + op.fragment.durationSec,
      };
      appendingBytes = op.bytes;
      // Position comes from tfdt inside the segment. Never shift with
      // timestampOffset — offsetting t=0 files is what created buffer holes.
      if (sourceBuffer.timestampOffset !== 0) {
        sourceBuffer.timestampOffset = 0;
      }
      sourceBuffer.appendBuffer(media.slice().buffer);
    } catch (error) {
      pendingMark = null;
      appendingBytes = null;
      pumping = false;
      const quota =
        error instanceof DOMException && error.name === "QuotaExceededError";
      if (quota && op.kind === "append" && !op.retried) {
        trimOutside(lastWindow.start, lastWindow.end);
        queue.push({ ...op, retried: true });
      }
      void pump();
    }
  };

  const queuedHasAppend = (index: number, fingerprint: string): boolean => {
    if (
      pendingMark?.index === index &&
      pendingMark.fingerprint === fingerprint
    ) {
      return true;
    }
    return queue.some(
      (op) =>
        op.kind === "append" &&
        op.fragment.index === index &&
        op.fragment.fingerprint === fingerprint,
    );
  };

  const fetchBytes = (path: string): Promise<Uint8Array | null> => {
    const existing = inflightFetch.get(path);
    if (existing) return existing;
    const url = mediaUrlForBakePath(path);
    const pending = fetch(url)
      .then(async (res) => {
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!fmp4HasMediaFragment(buf)) return null;
        return buf;
      })
      .catch(() => null)
      .finally(() => {
        inflightFetch.delete(path);
      });
    inflightFetch.set(path, pending);
    return pending;
  };

  const feed = (
    currentSec: number,
    playing: boolean,
    fragments: readonly ReadyTimelineFragment[],
  ) => {
    const behind = playing ? MSE_BUFFER_BEHIND_SEC : MSE_SCRUB_WINDOW_SEC;
    const ahead = playing ? MSE_BUFFER_AHEAD_SEC : MSE_SCRUB_WINDOW_SEC;
    const windowStart = Math.max(0, currentSec - behind);
    const windowEnd = currentSec + ahead;
    lastWindow = { start: windowStart, end: windowEnd };

    // Covering fragment first, then forward, then behind — a scrub target
    // paints as fast as possible. Out-of-order appends are fine (tfdt).
    const ordered = [...fragments]
      .filter((frag) => {
        const fragEnd = frag.startSec + frag.durationSec;
        return fragEnd > windowStart && frag.startSec < windowEnd;
      })
      .sort((a, b) => {
        const rank = (frag: ReadyTimelineFragment) => {
          const fragEnd = frag.startSec + frag.durationSec;
          if (currentSec >= frag.startSec && currentSec < fragEnd) return -1;
          if (frag.startSec >= currentSec) return frag.startSec - currentSec;
          return ahead + (currentSec - frag.startSec);
        };
        return rank(a) - rank(b);
      });

    for (const frag of ordered) {
      const fragEnd = frag.startSec + frag.durationSec;
      const have = appended.get(frag.index);
      if (have && have.fingerprint !== frag.fingerprint) {
        // Re-baked content. Never yank the range under a playing playhead —
        // pick it up on the next pass once the playhead has moved on.
        const underPlayhead =
          playing && currentSec >= frag.startSec - 0.25 && currentSec < fragEnd + 0.25;
        if (underPlayhead) continue;
        appended.delete(frag.index);
        enqueue({ kind: "remove", start: frag.startSec, end: fragEnd });
      }
      if (appended.get(frag.index)?.fingerprint === frag.fingerprint) continue;
      if (queuedHasAppend(frag.index, frag.fingerprint)) continue;
      void fetchBytes(frag.path).then((bytes) => {
        if (!bytes || destroyed || !warmed) return;
        // Re-check: parallel feed passes share one fetch promise, and each
        // resolution lands here — only the first may enqueue.
        if (appended.get(frag.index)?.fingerprint === frag.fingerprint) return;
        if (queuedHasAppend(frag.index, frag.fingerprint)) return;
        enqueue({ kind: "append", fragment: frag, bytes });
      });
    }

    // Trim only while paused — remove() near a playing playhead stalls WebKit.
    if (!playing) {
      trimOutside(windowStart, windowEnd);
    }
  };

  return {
    video,
    setDuration(sec) {
      const next = Math.max(0, sec);
      if (Math.abs(next - durationSec) < 1e-6) return;
      durationSec = next;
      if (mediaSource?.readyState === "open") {
        enqueue({ kind: "duration", sec: durationSec });
      }
    },
    sync(currentSec, playing, fragments, opts = {}) {
      if (destroyed || !warmed) return;
      attach();
      wantPlaying = playing;
      if (opts.feed !== false) {
        feed(currentSec, playing, fragments);
      }
      if (opts.seek === true && Number.isFinite(currentSec)) {
        pendingSeekSec = Math.max(0, currentSec);
        // Freeze rather than keep rolling the wrong position.
        if (!coversRange(pendingSeekSec, 0) && !video.paused) video.pause();
        tryApplyPendingSeek();
      }
      ensurePlayback();
    },
    getTime() {
      const t = video.currentTime;
      return Number.isFinite(t) && t > 0 ? t : 0;
    },
    hasPendingSeek() {
      return pendingSeekSec != null;
    },
    isEnded() {
      return video.ended;
    },
    warm() {
      if (destroyed) return;
      warmed = true;
      if (!video.parentNode) surface.appendChild(video);
      if (!visible) video.style.display = "none";
      attach();
    },
    show() {
      if (destroyed) return;
      warmed = true;
      visible = true;
      if (!video.parentNode) surface.appendChild(video);
      video.style.display = "";
      attach();
    },
    hide() {
      visible = false;
      wantPlaying = false;
      playPending = false;
      video.pause();
      video.style.display = "none";
    },
    isActive() {
      return visible;
    },
    covers(sec, aheadSec = 0) {
      return coversRange(sec, aheadSec);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      warmed = false;
      visible = false;
      resetMedia();
      video.remove();
    },
  };
}
