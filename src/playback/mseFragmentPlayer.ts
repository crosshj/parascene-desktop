import { mediaUrlForBakePath } from "../library/slideshowMedia";
import {
  fmp4HasMediaFragment,
  splitFmp4,
} from "./fmp4Boxes";

export const TIMELINE_MSE_MIME = 'video/mp4; codecs="avc1.42E01E"';

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
  | { kind: "append"; fragment: ReadyTimelineFragment; bytes: Uint8Array }
  | { kind: "remove"; start: number; end: number }
  | { kind: "duration"; sec: number };

export type MseSyncOpts = {
  /** Append/remove fragments for the playhead window. Default true. */
  feed?: boolean;
  /** Jump currentTime. Default true. Playing ticks should pass false. */
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
  /** Attach MediaSource and fetch/append without showing the element. */
  warm(): void;
  show(): void;
  hide(): void;
  isActive(): boolean;
  /** True when `sec` is inside a buffered range with `aheadSec` of future data. */
  covers(sec: number, aheadSec?: number): boolean;
  destroy(): void;
};

/**
 * One HTMLVideoElement + one SourceBuffer. Fragments are independently
 * replaceable CMAF chunks with stable timeline ranges.
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
  const appended = new Map<number, string>();
  const inflightFetch = new Map<string, Promise<Uint8Array | null>>();
  const queue: BufferOp[] = [];
  let pumping = false;
  let pendingPlay = false;
  let pendingMark: { index: number; fingerprint: string } | null = null;

  const resetMedia = () => {
    initAppended = false;
    pendingMark = null;
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
            appended.set(pendingMark.index, pendingMark.fingerprint);
            pendingMark = null;
          }
          pumping = false;
          void pump();
        });
        sourceBuffer.addEventListener("error", () => {
          pendingMark = null;
          pumping = false;
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

  const pump = async () => {
    if (destroyed || pumping) return;
    if (!sourceBuffer || sourceBuffer.updating) return;
    if (mediaSource?.readyState !== "open") return;
    const op = queue.shift();
    if (!op) {
      if (pendingPlay && visible) {
        pendingPlay = false;
        video.muted = true;
        void video.play().catch(() => {});
      }
      return;
    }
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
        queue.unshift({
          kind: "append",
          fragment: op.fragment,
          bytes: op.bytes,
        });
        sourceBuffer.timestampOffset = 0;
        sourceBuffer.appendBuffer(init.slice().buffer);
        return;
      }
      if (media.byteLength === 0) {
        pumping = false;
        void pump();
        return;
      }
      pendingMark = {
        index: op.fragment.index,
        fingerprint: op.fragment.fingerprint,
      };
      // Half-frame overlap so adjacent closed GOPs don't leave a buffered hole
      // (Safari waits at a 1-sample gap — looks like a cut flash).
      const overlap =
        op.fragment.index > 0 ? 1 / 60 : 0;
      sourceBuffer.timestampOffset = Math.max(0, op.fragment.startSec - overlap);
      sourceBuffer.appendBuffer(media.slice().buffer);
    } catch {
      pendingMark = null;
      pumping = false;
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

  const bufferedCovers = (start: number, end: number): boolean => {
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      if (ranges.start(i) <= start + 0.05 && ranges.end(i) >= end - 0.05) {
        return true;
      }
    }
    return false;
  };

  const trimBuffered = (keepFrom: number, keepTo: number) => {
    if (!sourceBuffer || sourceBuffer.updating) return;
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (end <= keepFrom || start >= keepTo) {
        enqueue({ kind: "remove", start, end });
      } else {
        if (start < keepFrom - 0.25) {
          enqueue({ kind: "remove", start, end: keepFrom });
        }
        if (end > keepTo + 0.25) {
          enqueue({ kind: "remove", start: keepTo, end });
        }
      }
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
      const doFeed = opts.feed !== false;
      const doSeek = opts.seek !== false;
      if (doFeed) {
        const behind = playing ? MSE_BUFFER_BEHIND_SEC : MSE_SCRUB_WINDOW_SEC;
        const ahead = playing ? MSE_BUFFER_AHEAD_SEC : MSE_SCRUB_WINDOW_SEC;
        const windowStart = Math.max(0, currentSec - behind);
        const windowEnd = currentSec + ahead;
        for (const frag of fragments) {
          const fragEnd = frag.startSec + frag.durationSec;
          if (fragEnd <= windowStart || frag.startSec >= windowEnd) continue;
          const have = appended.get(frag.index);
          if (have && have !== frag.fingerprint) {
            enqueue({
              kind: "remove",
              start: frag.startSec,
              end: fragEnd,
            });
            appended.delete(frag.index);
          }
          if (appended.get(frag.index) === frag.fingerprint) continue;
          if (queuedHasAppend(frag.index, frag.fingerprint)) continue;
          if (
            bufferedCovers(frag.startSec, fragEnd) &&
            have === frag.fingerprint
          ) {
            continue;
          }
          void fetchBytes(frag.path).then((bytes) => {
            if (!bytes || destroyed || !warmed) return;
            enqueue({ kind: "append", fragment: frag, bytes });
          });
        }
        // Don't trim on a playing tick — yanking ranges mid-GOP flashes black.
        if (doSeek || !playing) {
          trimBuffered(windowStart, windowEnd);
        }
      }
      const inRange = coversRange(currentSec, 0);
      if (doSeek && inRange && Number.isFinite(currentSec)) {
        try {
          video.currentTime = currentSec;
        } catch {
          /* ignore */
        }
      }
      if (playing) {
        if (video.paused) {
          video.muted = true;
          const play = video.play();
          if (play)
            void play.catch(() => {
              pendingPlay = true;
            });
        }
      } else if (!video.paused) {
        video.pause();
      }
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
      pendingPlay = false;
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
