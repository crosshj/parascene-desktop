import type { FrameProvider, FrameTarget } from "./types";
import { webCodecsAvailable } from "./capabilities";
import { emitPreviewInstrument } from "./instrument";
import {
  openHtmlVideo,
  paintHtmlVideoFrame,
  preloadHtmlVideo,
} from "./htmlVideoProvider";
import {
  createCanvas2DCompositor,
  type PreviewCompositor,
} from "./compositor";

const imageBitmaps = new Map<string, ImageBitmap>();
const imageInflight = new Map<string, Promise<ImageBitmap>>();

export async function loadImageBitmap(
  assetId: string,
  url: string,
): Promise<ImageBitmap> {
  const cached = imageBitmaps.get(assetId);
  if (cached) return cached;
  let pending = imageInflight.get(assetId);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      imageBitmaps.set(assetId, bitmap);
      imageInflight.delete(assetId);
      return bitmap;
    })().catch((err) => {
      imageInflight.delete(assetId);
      throw err;
    });
    imageInflight.set(assetId, pending);
  }
  return pending;
}

export function releaseImageBitmap(assetId: string): void {
  const bmp = imageBitmaps.get(assetId);
  if (bmp) {
    bmp.close();
    imageBitmaps.delete(assetId);
  }
}

/**
 * Frame request scheduler: generation-gated paint onto a persistent canvas.
 * Keeps the last valid frame visible while a new frame decodes.
 */
export class PreviewRenderer {
  private compositor: PreviewCompositor | null = null;
  private renderGeneration = 0;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly frameProvider: FrameProvider,
  ) {
    this.compositor = createCanvas2DCompositor(canvas);
  }

  resize(cssWidth: number, cssHeight: number, dpr = window.devicePixelRatio || 1) {
    this.compositor?.resize(cssWidth, cssHeight, dpr);
  }

  /** Hard clear only when there is no active target (empty gap). */
  showEmpty(): void {
    this.compositor?.clear();
  }

  async renderTarget(
    target: FrameTarget,
    opts?: {
      timelineTimeUs?: number;
      imageUrl?: string | null;
      proxyUrl?: string | null;
      playing?: boolean;
      muted?: boolean;
      volume?: number;
    },
  ): Promise<void> {
    if (this.disposed || !this.compositor) return;
    const generation = ++this.renderGeneration;
    const timelineTimeUs = opts?.timelineTimeUs;
    const isStale = () =>
      generation !== this.renderGeneration || this.disposed;

    if (target.kind === "image") {
      const url = opts?.imageUrl;
      if (!url) return;
      try {
        const bitmap = await loadImageBitmap(target.assetId, url);
        if (isStale()) return;
        this.compositor.drawImageBitmap(bitmap);
        emitPreviewInstrument({
          requestedTimelineTimeUs: timelineTimeUs,
          assetId: target.assetId,
          requestedSourceTimeUs: 0,
          returnedFrameTimeUs: 0,
          keyframeTimeUs: null,
          decodeDurationMs: 0,
          cacheHit: true,
          generation,
          staleRejected: false,
          liveCachedFrames: null,
        });
      } catch {
        /* keep last frame */
      }
      return;
    }

    const proxyUrl = opts?.proxyUrl;
    if (!proxyUrl) return;

    // WKWebView on older macOS has no WebCodecs — hidden video seek + canvas blit.
    if (!webCodecsAvailable()) {
      await paintHtmlVideoFrame(
        this.compositor,
        target.assetId,
        proxyUrl,
        target.sourceTimeUs,
        generation,
        isStale,
        {
          playing: Boolean(opts?.playing),
          muted: opts?.muted,
          volume: opts?.volume,
        },
      );
      return;
    }

    try {
      await this.frameProvider.open(target.assetId, proxyUrl);
      if (isStale()) return;

      const frame = await this.frameProvider.getFrame(
        target.assetId,
        target.sourceTimeUs,
        generation,
      );

      if (!frame) {
        emitPreviewInstrument({
          requestedTimelineTimeUs: timelineTimeUs,
          assetId: target.assetId,
          requestedSourceTimeUs: target.sourceTimeUs,
          returnedFrameTimeUs: null,
          keyframeTimeUs: null,
          decodeDurationMs: null,
          cacheHit: null,
          generation,
          staleRejected: isStale(),
          liveCachedFrames: null,
        });
        return;
      }

      if (isStale()) {
        frame.close();
        emitPreviewInstrument({
          requestedTimelineTimeUs: timelineTimeUs,
          assetId: target.assetId,
          requestedSourceTimeUs: target.sourceTimeUs,
          returnedFrameTimeUs: frame.timestamp,
          keyframeTimeUs: null,
          decodeDurationMs: null,
          cacheHit: null,
          generation,
          staleRejected: true,
          liveCachedFrames: null,
        });
        return;
      }

      this.compositor.drawVideoFrame(frame);
      frame.close();
    } catch {
      /* keep last frame visible */
    }
  }

  dispose(): void {
    this.disposed = true;
    this.renderGeneration += 1;
    this.compositor = null;
  }
}

/** Open a video asset on whichever backend is active. */
export async function openPreviewVideo(
  assetId: string,
  proxyUrl: string,
  frameProvider: FrameProvider,
): Promise<{ durationUs: number }> {
  if (!webCodecsAvailable()) {
    return openHtmlVideo(assetId, proxyUrl);
  }
  const provider = frameProvider as FrameProvider & {
    openWithDuration(
      a: string,
      u: string,
    ): Promise<{ durationUs: number }>;
  };
  return provider.openWithDuration(assetId, proxyUrl);
}

export function preloadPreviewVideo(
  assetId: string,
  proxyUrl: string,
  startTimeUs: number,
  endTimeUs: number,
  frameProvider: FrameProvider,
): void {
  if (!webCodecsAvailable()) {
    preloadHtmlVideo(assetId, proxyUrl, startTimeUs, endTimeUs);
    return;
  }
  void (async () => {
    try {
      await frameProvider.open(assetId, proxyUrl);
      frameProvider.preload(assetId, startTimeUs, endTimeUs);
    } catch {
      /* ignore */
    }
  })();
}
