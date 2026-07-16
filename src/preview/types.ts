/** Shared preview pipeline types (timeline resolve ↔ FrameProvider ↔ canvas). */

export type FrameTarget = {
  assetId: string;
  sourceTimeUs: number;
  clipId: string;
  kind: "video" | "image";
};

export type FrameProvider = {
  getFrame(
    assetId: string,
    sourceTimeUs: number,
    generation: number,
  ): Promise<VideoFrame | null>;

  preload(
    assetId: string,
    startTimeUs: number,
    endTimeUs: number,
  ): void;

  release(assetId: string): void;

  /** Open / warm a video asset at a proxy URL before getFrame. */
  open(assetId: string, proxyUrl: string): Promise<void>;

  dispose(): void;
};

export type PreviewInstrumentEvent = {
  requestedTimelineTimeUs?: number;
  assetId: string | null;
  requestedSourceTimeUs: number | null;
  returnedFrameTimeUs: number | null;
  keyframeTimeUs: number | null;
  decodeDurationMs: number | null;
  cacheHit: boolean | null;
  generation: number;
  staleRejected: boolean;
  liveCachedFrames: number | null;
};
