import type { PreviewCompositor } from "./compositor";
import { emitPreviewInstrument } from "./instrument";

type VideoSlot = {
  assetId: string;
  url: string;
  el: HTMLVideoElement;
  ready: Promise<void>;
  blitRaf: number | null;
  blitCompositor: PreviewCompositor | null;
};

const slots = new Map<string, VideoSlot>();

const PLAY_DRIFT_SEC = 0.4;
const SCRUB_TOL_SEC = 0.05;

function waitForEvent(
  el: HTMLVideoElement,
  name: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener(name, onOk);
      el.removeEventListener("error", onErr);
      window.clearTimeout(timer);
      ok ? resolve() : reject(new Error(`video ${name} failed`));
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    el.addEventListener(name, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

async function ensureSlot(assetId: string, url: string): Promise<VideoSlot> {
  const existing = slots.get(assetId);
  if (existing && existing.url === url) return existing;

  if (existing) {
    stopBlit(existing);
    existing.el.pause();
    existing.el.removeAttribute("src");
    existing.el.load();
    existing.el.remove();
    slots.delete(assetId);
  }

  const el = document.createElement("video");
  el.playsInline = true;
  el.preload = "auto";
  el.muted = true;
  el.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1280px;height:720px;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  el.src = url;

  const ready = (async () => {
    try {
      await waitForEvent(el, "loadeddata");
    } catch {
      await waitForEvent(el, "loadedmetadata");
    }
  })();

  const slot: VideoSlot = {
    assetId,
    url,
    el,
    ready,
    blitRaf: null,
    blitCompositor: null,
  };
  slots.set(assetId, slot);
  await ready;
  return slot;
}

function stopBlit(slot: VideoSlot): void {
  if (slot.blitRaf != null) {
    cancelAnimationFrame(slot.blitRaf);
    slot.blitRaf = null;
  }
  slot.blitCompositor = null;
}

function startBlit(slot: VideoSlot, compositor: PreviewCompositor): void {
  if (slot.blitCompositor === compositor && slot.blitRaf != null) return;
  stopBlit(slot);
  slot.blitCompositor = compositor;
  const tick = () => {
    if (slot.blitCompositor !== compositor) return;
    if (slot.el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      compositor.drawVideoElement(slot.el);
    }
    slot.blitRaf = requestAnimationFrame(tick);
  };
  slot.blitRaf = requestAnimationFrame(tick);
}

async function waitForPaint(el: HTMLVideoElement): Promise<void> {
  const rvfc = (
    el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }
  ).requestVideoFrameCallback;
  if (rvfc) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rvfc.call(el, () => done());
      window.setTimeout(done, 250);
    });
    return;
  }
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await waitForEvent(el, "seeked", 1500).catch(() => undefined);
}

async function seekPaused(el: HTMLVideoElement, sec: number): Promise<void> {
  const target = Math.max(0, sec);
  el.pause();
  if (Math.abs(el.currentTime - target) < SCRUB_TOL_SEC) {
    await waitForPaint(el);
    return;
  }
  el.currentTime = target;
  await waitForEvent(el, "seeked", 4000).catch(() => undefined);
  await waitForPaint(el);
}

export type HtmlPaintOpts = {
  playing?: boolean;
  /** When false, unmute and play clip audio from this element. */
  muted?: boolean;
  volume?: number;
};

/**
 * Hidden `<video>` → canvas blit when WebCodecs is unavailable.
 * Scrub: pause + seek. Play: native playback + rAF blit (no seek every tick).
 */
export async function paintHtmlVideoFrame(
  compositor: PreviewCompositor,
  assetId: string,
  mediaUrl: string,
  sourceTimeUs: number,
  generation: number,
  isStale: () => boolean,
  opts?: HtmlPaintOpts,
): Promise<boolean> {
  const t0 = performance.now();
  const playing = Boolean(opts?.playing);
  const muted = opts?.muted !== false;
  const volume = Math.max(0, Math.min(1, (opts?.volume ?? 80) / 100));

  try {
    const slot = await ensureSlot(assetId, mediaUrl);
    // While playing, do not abandon the start just because a newer playhead
    // tick bumped generation — that was cancelling play() every frame.
    if (!playing && isStale()) return false;
    await slot.ready;
    if (!playing && isStale()) return false;

    const sec = Math.max(0, sourceTimeUs / 1e6);
    const el = slot.el;
    el.muted = muted;
    el.volume = muted ? 0 : volume;

    const drift = Math.abs(el.currentTime - sec);

    if (playing) {
      if (el.paused || drift > PLAY_DRIFT_SEC) {
        await seekPaused(el, sec);
        try {
          await el.play();
        } catch {
          /* ignore autoplay failures */
        }
      }
      startBlit(slot, compositor);
      if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        compositor.drawVideoElement(el);
      }
    } else {
      stopBlit(slot);
      for (const other of slots.values()) {
        if (other.assetId !== assetId && !other.el.paused) other.el.pause();
      }
      await seekPaused(el, sec);
      if (isStale()) return false;
      compositor.drawVideoElement(el);
    }

    emitPreviewInstrument({
      assetId,
      requestedSourceTimeUs: sourceTimeUs,
      returnedFrameTimeUs: Math.round(el.currentTime * 1e6),
      keyframeTimeUs: null,
      decodeDurationMs: performance.now() - t0,
      cacheHit: false,
      generation,
      staleRejected: false,
      liveCachedFrames: null,
    });
    return true;
  } catch {
    return false;
  }
}

export function releaseHtmlVideoAsset(assetId: string): void {
  const slot = slots.get(assetId);
  if (!slot) return;
  stopBlit(slot);
  slot.el.pause();
  slot.el.removeAttribute("src");
  slot.el.load();
  slot.el.remove();
  slots.delete(assetId);
}

export function disposeHtmlVideoPool(): void {
  for (const id of [...slots.keys()]) releaseHtmlVideoAsset(id);
}

export function preloadHtmlVideo(
  assetId: string,
  mediaUrl: string,
  startTimeUs: number,
  endTimeUs: number,
): void {
  void (async () => {
    try {
      const slot = await ensureSlot(assetId, mediaUrl);
      await slot.ready;
      await seekPaused(slot.el, startTimeUs / 1e6);
      await seekPaused(slot.el, endTimeUs / 1e6);
    } catch {
      /* ignore */
    }
  })();
}

export async function openHtmlVideo(
  assetId: string,
  mediaUrl: string,
): Promise<{ durationUs: number }> {
  const slot = await ensureSlot(assetId, mediaUrl);
  await slot.ready;
  const d = slot.el.duration;
  return {
    durationUs: Math.round((Number.isFinite(d) && d > 0 ? d : 0) * 1e6),
  };
}

/** Pause all hidden preview videos (e.g. leaving timeline play). */
export function pauseAllHtmlVideos(): void {
  for (const slot of slots.values()) {
    stopBlit(slot);
    slot.el.pause();
  }
}
