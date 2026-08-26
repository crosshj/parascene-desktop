import { mediaUrlForBakePath } from "../library/slideshowMedia";
import {
  fmp4HasMediaFragment,
  formatTrackRange,
  inspectFragmentTimestamps,
  splitFmp4,
} from "./fmp4Boxes";
import {
  bufferedCoversRangeExact,
  bufferedIsContinuous,
  formatBufferedRanges,
  timeRangesToArray,
} from "./bufferedRanges";
import { logPreviewEvent } from "./previewDiagnostics";

/** Baseline level 3.1 — matches the encoder and covers the High (960x540) preview. */
export const TIMELINE_MSE_MIME = 'video/mp4; codecs="avc1.42E01F"';

export const MSE_BUFFER_AHEAD_SEC = 8;
export const MSE_BUFFER_BEHIND_SEC = 2;
/** Paused scrub keeps a wider cached window so random seeks land on a frame. */
export const MSE_SCRUB_WINDOW_SEC = 12;

/** Fetch deadline — F13 detection. */
const FETCH_TIMEOUT_MS = 15_000;
/** K2 retry budget before promotion to reset/blocked. */
const TICKET_MAX_ATTEMPTS = 5;
const TICKET_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000];
/** K3 reset budget per minute. */
const RESET_MAX_PER_WINDOW = 3;
const RESET_WINDOW_MS = 60_000;

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
      generation: number;
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

export type MsePreviewPhase = "idle" | "loading" | "blocked";

export type MseFragmentPlayer = {
  readonly video: HTMLVideoElement;
  setDuration(sec: number): void;
  /** Discard stale fetch/append work after timeline or rendition change. */
  setGeneration(token: number): void;
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
  /** True when `[startSec, endSec]` is fully inside SourceBuffer.buffered. */
  coversRangeExact(startSec: number, endSec: number): boolean;
  /** True when `sec` is inside a buffered range with `aheadSec` of future data. */
  covers(sec: number, aheadSec?: number): boolean;
  /** How many fragments have been successfully appended this session. */
  appendedCount(): number;
  getPreviewPhase(): MsePreviewPhase;
  getBlockedReason(): string | null;
  /** User Retry from blocked state. */
  retryBlocked(): void;
  destroy(): void;
};

export type MseFragmentPlayerOptions = {
  /** Called when a fragment fetch fails (CSP, 4xx, corrupt fMP4). */
  onFetchError?: (message: string) => void;
  onBlocked?: (reason: string) => void;
};

type AppendedRec = {
  fingerprint: string;
  start: number;
  end: number;
};

type LoadTicket = {
  key: string;
  fragment: ReadyTimelineFragment;
  generation: number;
  attempts: number;
  wakeTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * One HTMLVideoElement + one SourceBuffer. Fragments are CMAF media segments
 * on a shared timeline (tfdt carries the position; timestampOffset stays 0).
 * While playing, the element free-runs and IS the clock; the engine reads
 * getTime(). Seeks are pending-until-buffered so they are never lost.
 */
export function createMseFragmentPlayer(
  surface: HTMLElement,
  options: MseFragmentPlayerOptions = {},
): MseFragmentPlayer {
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
  let generation = 0;
  let previewPhase: MsePreviewPhase = "idle";
  let blockedReason: string | null = null;
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
  const tickets = new Map<string, LoadTicket>();
  const queue: BufferOp[] = [];
  let pumping = false;
  let pendingMark: {
    index: number;
    fingerprint: string;
    start: number;
    end: number;
  } | null = null;
  let resetTimestamps: number[] = [];
  let appendErrors = 0;
  let updateEndWatchdog: ReturnType<typeof setTimeout> | null = null;

  const bufferedRanges = () => timeRangesToArray(video.buffered);

  const coversRangeExact = (startSec: number, endSec: number): boolean =>
    bufferedCoversRangeExact(bufferedRanges(), startSec, endSec);

  const coversRange = (sec: number, aheadSec = 0): boolean => {
    const need =
      durationSec > 0
        ? Math.min(sec + Math.max(0, aheadSec), Math.max(0, durationSec - 0.001))
        : sec + Math.max(0, aheadSec);
    return coversRangeExact(sec, need);
  };

  const fragmentEnd = (frag: ReadyTimelineFragment) =>
    frag.startSec + frag.durationSec;

  const isFragmentVerified = (frag: ReadyTimelineFragment): boolean =>
    coversRangeExact(frag.startSec, fragmentEnd(frag));

  const ticketKey = (frag: ReadyTimelineFragment) =>
    `${frag.index}:${frag.fingerprint}`;

  const setPreviewPhase = (phase: MsePreviewPhase, reason?: string) => {
    previewPhase = phase;
    if (phase === "blocked") {
      blockedReason = reason?.trim() || "Preview blocked";
      options.onBlocked?.(blockedReason);
      logPreviewEvent(
        { ts: Date.now(), phase: "blocked", detail: blockedReason },
        true,
      );
    } else {
      blockedReason = null;
    }
  };

  const clearTickets = () => {
    for (const ticket of tickets.values()) {
      if (ticket.wakeTimer) clearTimeout(ticket.wakeTimer);
    }
    tickets.clear();
  };

  const backoffMs = (attempt: number) =>
    TICKET_BACKOFF_MS[Math.min(attempt, TICKET_BACKOFF_MS.length - 1)] ??
    8000;

  const scheduleTicketWake = (ticket: LoadTicket, delayMs: number) => {
    if (ticket.wakeTimer) clearTimeout(ticket.wakeTimer);
    ticket.wakeTimer = setTimeout(() => {
      ticket.wakeTimer = null;
      if (destroyed || ticket.generation !== generation) return;
      void runTicket(ticket);
    }, delayMs);
  };

  const ensurePlayback = () => {
    if (destroyed) return;
    if (!wantPlaying) {
      playPending = false;
      if (!video.paused) video.pause();
      return;
    }
    if (previewPhase === "blocked") return;
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
          (err) => {
            playPending = false;
            logPreviewEvent({
              ts: Date.now(),
              f: "F24",
              phase: "play-rejected",
              detail: err instanceof Error ? err.message : String(err),
            });
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
    const buffered = bufferedRanges();
    logPreviewEvent({
      ts: Date.now(),
      fragment: mark.index,
      generation,
      phase: "append",
      detail: `video ${formatTrackRange(report.video)}`,
    });
    if (!bufferedIsContinuous(buffered) && queue.length === 0) {
      logPreviewEvent({
        ts: Date.now(),
        f: "F17",
        fragment: mark.index,
        phase: "buffer-gap",
        detail: formatBufferedRanges(buffered),
      });
    }
  };

  let appendingBytes: Uint8Array | null = null;

  const canReset = (): boolean => {
    const now = Date.now();
    resetTimestamps = resetTimestamps.filter((t) => now - t < RESET_WINDOW_MS);
    return resetTimestamps.length < RESET_MAX_PER_WINDOW;
  };

  const resetSession = (reason: string) => {
    if (destroyed) return;
    if (!canReset()) {
      setPreviewPhase("blocked", `${reason} — retry preview`);
      return;
    }
    resetTimestamps.push(Date.now());
    appendErrors = 0;
    logPreviewEvent({
      ts: Date.now(),
      phase: "reset",
      detail: reason,
      generation,
    });
    resetMedia();
    attach();
    setPreviewPhase("loading");
  };

  const resetMedia = () => {
    initAppended = false;
    pendingMark = null;
    appendingBytes = null;
    pendingSeekSec = null;
    playPending = false;
    appended.clear();
    queue.length = 0;
    clearTickets();
    sourceBuffer = null;
    if (updateEndWatchdog) {
      clearTimeout(updateEndWatchdog);
      updateEndWatchdog = null;
    }
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
    const sourceOpenDeadline = setTimeout(() => {
      if (destroyed || sourceBuffer) return;
      logPreviewEvent({ ts: Date.now(), f: "F19", phase: "sourceopen-timeout" });
      resetSession("MediaSource did not open");
    }, 10_000);
    mediaSource.addEventListener("sourceopen", () => {
      clearTimeout(sourceOpenDeadline);
      if (destroyed || !mediaSource || sourceBuffer) return;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(TIMELINE_MSE_MIME);
        sourceBuffer.mode = "segments";
        sourceBuffer.addEventListener("updateend", () => {
          if (updateEndWatchdog) {
            clearTimeout(updateEndWatchdog);
            updateEndWatchdog = null;
          }
          if (pendingMark) {
            appended.set(pendingMark.index, {
              fingerprint: pendingMark.fingerprint,
              start: pendingMark.start,
              end: pendingMark.end,
            });
            if (appendingBytes) logAppend(pendingMark, appendingBytes);
            pendingMark = null;
            appendingBytes = null;
            appendErrors = 0;
          }
          pumping = false;
          tryApplyPendingSeek();
          ensurePlayback();
          void pump();
        });
        sourceBuffer.addEventListener("error", () => {
          appendErrors += 1;
          pendingMark = null;
          appendingBytes = null;
          pumping = false;
          logPreviewEvent({
            ts: Date.now(),
            f: "F15",
            phase: "sourcebuffer-error",
            attempt: appendErrors,
          });
          if (appendErrors >= 3) {
            resetSession("SourceBuffer error");
          } else {
            void pump();
          }
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
    if (destroyed || previewPhase === "blocked") return;
    queue.push(op);
    void pump();
  };

  const trimOutside = (keepFrom: number, keepTo: number) => {
    for (const [index, rec] of [...appended]) {
      if (rec.end <= keepFrom || rec.start >= keepTo) {
        appended.delete(index);
        enqueue({ kind: "remove", start: rec.start, end: rec.end });
      }
    }
  };

  const pump = () => {
    if (destroyed || pumping || previewPhase === "blocked") return;
    if (!sourceBuffer || sourceBuffer.updating) return;
    if (mediaSource?.readyState !== "open") return;
    const op = queue.shift();
    if (!op) return;
    pumping = true;
    updateEndWatchdog = setTimeout(() => {
      if (!pumping) return;
      logPreviewEvent({ ts: Date.now(), f: "F20", phase: "updateend-timeout" });
      resetSession("Append stalled");
    }, 15_000);
    try {
      if (op.kind === "duration") {
        try {
          mediaSource.duration = op.sec;
        } catch {
          /* ignore */
        }
        pumping = false;
        if (updateEndWatchdog) {
          clearTimeout(updateEndWatchdog);
          updateEndWatchdog = null;
        }
        void pump();
        return;
      }
      if (op.kind === "remove") {
        const end = Math.max(op.start + 0.001, op.end);
        sourceBuffer.remove(op.start, end);
        return;
      }
      if (op.generation !== generation) {
        pumping = false;
        if (updateEndWatchdog) {
          clearTimeout(updateEndWatchdog);
          updateEndWatchdog = null;
        }
        void pump();
        return;
      }
      const { init, media } = splitFmp4(op.bytes);
      if (!initAppended) {
        if (init.byteLength === 0) {
          pumping = false;
          if (updateEndWatchdog) {
            clearTimeout(updateEndWatchdog);
            updateEndWatchdog = null;
          }
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
        if (updateEndWatchdog) {
          clearTimeout(updateEndWatchdog);
          updateEndWatchdog = null;
        }
        void pump();
        return;
      }
      if (
        appended.get(op.fragment.index)?.fingerprint === op.fragment.fingerprint &&
        isFragmentVerified(op.fragment)
      ) {
        pumping = false;
        if (updateEndWatchdog) {
          clearTimeout(updateEndWatchdog);
          updateEndWatchdog = null;
        }
        void pump();
        return;
      }
      pendingMark = {
        index: op.fragment.index,
        fingerprint: op.fragment.fingerprint,
        start: op.fragment.startSec,
        end: fragmentEnd(op.fragment),
      };
      appendingBytes = op.bytes;
      if (sourceBuffer.timestampOffset !== 0) {
        sourceBuffer.timestampOffset = 0;
      }
      sourceBuffer.appendBuffer(media.slice().buffer);
    } catch (error) {
      pendingMark = null;
      appendingBytes = null;
      pumping = false;
      if (updateEndWatchdog) {
        clearTimeout(updateEndWatchdog);
        updateEndWatchdog = null;
      }
      const quota =
        error instanceof DOMException && error.name === "QuotaExceededError";
      if (quota && op.kind === "append" && !op.retried) {
        trimOutside(lastWindow.start, lastWindow.end);
        queue.push({ ...op, retried: true });
      } else if (quota) {
        resetSession("Quota exceeded");
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

  const fetchBytes = (path: string, signal: AbortSignal): Promise<Uint8Array | null> => {
    const existing = inflightFetch.get(path);
    if (existing) return existing;
    let url: string;
    try {
      url = mediaUrlForBakePath(path);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : `Invalid media path: ${path}`;
      options.onFetchError?.(message);
      return Promise.resolve(null);
    }
    const pending = fetch(url, { signal })
      .then(async (res) => {
        if (!res.ok) {
          options.onFetchError?.(
            `Preview fragment fetch failed (${res.status}). Check that media:// is allowed in connect-src.`,
          );
          return null;
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!fmp4HasMediaFragment(buf)) {
          options.onFetchError?.(
            "Preview fragment is not a valid fMP4 media segment.",
          );
          return null;
        }
        return buf;
      })
      .catch((err) => {
        if (signal.aborted) return null;
        const detail =
          err instanceof Error ? err.message : "network or CSP blocked";
        options.onFetchError?.(`Preview fragment fetch blocked: ${detail}`);
        return null;
      })
      .finally(() => {
        inflightFetch.delete(path);
      });
    inflightFetch.set(path, pending);
    return pending;
  };

  const runTicket = async (ticket: LoadTicket) => {
    if (destroyed || previewPhase === "blocked") return;
    if (ticket.generation !== generation) return;
    const frag = ticket.fragment;
    if (isFragmentVerified(frag)) {
      tickets.delete(ticket.key);
      return;
    }
    if (queuedHasAppend(frag.index, frag.fingerprint)) return;

    ticket.attempts += 1;
    if (ticket.attempts > TICKET_MAX_ATTEMPTS) {
      tickets.delete(ticket.key);
      resetSession(`Fragment ${frag.index} load failed`);
      return;
    }

    setPreviewPhase("loading");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const bytes = await fetchBytes(frag.path, controller.signal);
    clearTimeout(timeout);

    if (destroyed || ticket.generation !== generation) return;
    if (!bytes || !warmed) {
      scheduleTicketWake(ticket, backoffMs(ticket.attempts));
      return;
    }
    if (isFragmentVerified(frag)) {
      tickets.delete(ticket.key);
      return;
    }
    if (queuedHasAppend(frag.index, frag.fingerprint)) return;
    enqueue({
      kind: "append",
      fragment: frag,
      bytes,
      generation: ticket.generation,
    });
  };

  const ensureTicket = (frag: ReadyTimelineFragment) => {
    if (previewPhase === "blocked") return;
    if (isFragmentVerified(frag)) return;
    const key = ticketKey(frag);
    if (queuedHasAppend(frag.index, frag.fingerprint)) return;
    let ticket = tickets.get(key);
    if (!ticket) {
      ticket = {
        key,
        fragment: frag,
        generation,
        attempts: 0,
        wakeTimer: null,
      };
      tickets.set(key, ticket);
      void runTicket(ticket);
      return;
    }
    if (ticket.generation !== generation) {
      if (ticket.wakeTimer) clearTimeout(ticket.wakeTimer);
      ticket.generation = generation;
      ticket.attempts = 0;
      ticket.wakeTimer = null;
      void runTicket(ticket);
    }
  };

  const feed = (
    currentSec: number,
    playing: boolean,
    fragments: readonly ReadyTimelineFragment[],
  ) => {
    if (previewPhase === "blocked") return;
    const behind = playing ? MSE_BUFFER_BEHIND_SEC : MSE_SCRUB_WINDOW_SEC;
    const ahead = playing ? MSE_BUFFER_AHEAD_SEC : MSE_SCRUB_WINDOW_SEC;
    const windowStart = Math.max(0, currentSec - behind);
    const windowEnd = currentSec + ahead;
    lastWindow = { start: windowStart, end: windowEnd };

    const ordered = [...fragments]
      .filter((frag) => {
        const fragEnd = fragmentEnd(frag);
        return fragEnd > windowStart && frag.startSec < windowEnd;
      })
      .sort((a, b) => {
        const rank = (frag: ReadyTimelineFragment) => {
          const fragEnd = fragmentEnd(frag);
          if (currentSec >= frag.startSec && currentSec < fragEnd) return -1;
          if (frag.startSec >= currentSec) return frag.startSec - currentSec;
          return ahead + (currentSec - frag.startSec);
        };
        return rank(a) - rank(b);
      });

    let loading = false;
    for (const frag of ordered) {
      const fragEnd = fragmentEnd(frag);
      const have = appended.get(frag.index);
      if (have && have.fingerprint !== frag.fingerprint) {
        const underPlayhead =
          playing &&
          currentSec >= frag.startSec - 0.25 &&
          currentSec < fragEnd + 0.25;
        if (underPlayhead) continue;
        appended.delete(frag.index);
        enqueue({ kind: "remove", start: frag.startSec, end: fragEnd });
      }
      if (isFragmentVerified(frag)) continue;
      loading = true;
      ensureTicket(frag);
    }

    if (loading) setPreviewPhase("loading");
    else if (previewPhase === "loading") setPreviewPhase("idle");

    if (!playing) {
      trimOutside(windowStart, windowEnd);
    }
  };

  const onVideoError = () => {
    const code = video.error?.code;
    logPreviewEvent({
      ts: Date.now(),
      f: "F23",
      phase: "video-error",
      detail: code != null ? String(code) : undefined,
    });
    resetSession("Video decode error");
  };

  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStallTimer = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  };

  const onPlaybackStall = () => {
    if (pendingSeekSec != null) return;
    const sec = video.currentTime;
    if (!Number.isFinite(sec) || sec <= 0) return;
    if (!coversRange(sec, 0.02)) return;
    if (stallTimer) return;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (destroyed) return;
      const nowSec = video.currentTime;
      if (!Number.isFinite(nowSec) || !coversRange(nowSec, 0.02)) return;
      logPreviewEvent({ ts: Date.now(), f: "F25", phase: "playback-stall" });
      resetSession("Playback stalled inside buffered range");
    }, 1200);
  };

  const onPlaybackRecovered = () => {
    clearStallTimer();
  };

  video.addEventListener("error", onVideoError);
  video.addEventListener("waiting", onPlaybackStall);
  video.addEventListener("stalled", onPlaybackStall);
  video.addEventListener("playing", onPlaybackRecovered);
  video.addEventListener("canplay", onPlaybackRecovered);

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
    setGeneration(token) {
      if (token === generation) return;
      generation = token;
      clearTickets();
      logPreviewEvent({
        ts: Date.now(),
        phase: "generation",
        generation: token,
      });
    },
    sync(currentSec, playing, fragments, opts = {}) {
      if (destroyed || !warmed) return;
      if (previewPhase === "blocked") return;
      attach();
      wantPlaying = playing;
      if (opts.feed !== false) {
        feed(currentSec, playing, fragments);
      }
      if (opts.seek === true && Number.isFinite(currentSec)) {
        pendingSeekSec = Math.max(0, currentSec);
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
    coversRangeExact(startSec, endSec) {
      return coversRangeExact(startSec, endSec);
    },
    covers(sec, aheadSec = 0) {
      return coversRange(sec, aheadSec);
    },
    appendedCount() {
      return appended.size;
    },
    getPreviewPhase() {
      return previewPhase;
    },
    getBlockedReason() {
      return blockedReason;
    },
    retryBlocked() {
      if (previewPhase !== "blocked") return;
      setPreviewPhase("loading");
      appendErrors = 0;
      resetMedia();
      attach();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      warmed = false;
      visible = false;
      video.removeEventListener("error", onVideoError);
      video.removeEventListener("waiting", onPlaybackStall);
      video.removeEventListener("stalled", onPlaybackStall);
      video.removeEventListener("playing", onPlaybackRecovered);
      video.removeEventListener("canplay", onPlaybackRecovered);
      clearStallTimer();
      resetMedia();
      video.remove();
    },
  };
}
