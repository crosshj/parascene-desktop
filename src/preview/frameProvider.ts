import type { FrameProvider } from "./types";
import { webCodecsAvailable } from "./capabilities";
import { emitPreviewInstrument } from "./instrument";

type Pending = {
  resolve: (frame: VideoFrame | null) => void;
  reject: (err: Error) => void;
  generation: number;
  assetId: string;
  sourceTimeUs: number;
};

type WorkerFrameMsg = {
  type: "frame";
  requestId: number;
  assetId: string;
  generation: number;
  requestedSourceTimeUs: number;
  returnedFrameTimeUs: number;
  keyframeTimeUs: number | null;
  decodeDurationMs: number;
  cacheHit: boolean;
  liveCachedFrames: number;
  frame: VideoFrame;
};

type WorkerOpenOk = {
  type: "openOk";
  requestId: number;
  assetId: string;
  durationUs: number;
};

type WorkerError = {
  type: "error";
  requestId: number;
  message: string;
};

type WorkerOut = WorkerFrameMsg | WorkerOpenOk | WorkerError;

export type WorkerFrameProvider = FrameProvider & {
  openWithDuration(
    assetId: string,
    proxyUrl: string,
  ): Promise<{ durationUs: number }>;
};

/**
 * Main-thread FrameProvider that talks to the decode worker.
 * Generation checks reject stale frames before they are returned to callers.
 */
export function createWorkerFrameProvider(): WorkerFrameProvider {
  const worker = new Worker(new URL("./decodeWorker.ts", import.meta.url), {
    type: "module",
  });

  let nextRequestId = 1;
  const pending = new Map<number, Pending>();
  const openPending = new Map<
    number,
    {
      resolve: (info: { durationUs: number }) => void;
      reject: (err: Error) => void;
    }
  >();

  /** Latest generation observed per caller getFrame — used for stale drop. */
  let latestGeneration = 0;

  worker.onmessage = (event: MessageEvent<WorkerOut>) => {
    const msg = event.data;
    if (msg.type === "openOk") {
      const p = openPending.get(msg.requestId);
      openPending.delete(msg.requestId);
      p?.resolve({ durationUs: msg.durationUs });
      return;
    }
    if (msg.type === "error") {
      const open = openPending.get(msg.requestId);
      if (open) {
        openPending.delete(msg.requestId);
        open.reject(new Error(msg.message));
        return;
      }
      const p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      if (p) {
        emitPreviewInstrument({
          assetId: p.assetId,
          requestedSourceTimeUs: p.sourceTimeUs,
          returnedFrameTimeUs: null,
          keyframeTimeUs: null,
          decodeDurationMs: null,
          cacheHit: null,
          generation: p.generation,
          staleRejected: false,
          liveCachedFrames: null,
        });
        p.resolve(null);
      }
      return;
    }

    if (msg.type === "frame") {
      const p = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      const stale =
        !p ||
        msg.generation !== p.generation ||
        msg.generation < latestGeneration;

      emitPreviewInstrument({
        assetId: msg.assetId,
        requestedSourceTimeUs: msg.requestedSourceTimeUs,
        returnedFrameTimeUs: msg.returnedFrameTimeUs,
        keyframeTimeUs: msg.keyframeTimeUs,
        decodeDurationMs: msg.decodeDurationMs,
        cacheHit: msg.cacheHit,
        generation: msg.generation,
        staleRejected: Boolean(stale),
        liveCachedFrames: msg.liveCachedFrames,
      });

      if (stale) {
        try {
          msg.frame.close();
        } catch {
          /* ignore */
        }
        p?.resolve(null);
        return;
      }
      p.resolve(msg.frame);
    }
  };

  worker.onerror = (err) => {
    const error = new Error(err.message || "Decode worker error");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
    for (const p of openPending.values()) p.reject(error);
    openPending.clear();
  };

  const openWithDuration = (assetId: string, proxyUrl: string) => {
    const requestId = nextRequestId++;
    return new Promise<{ durationUs: number }>((resolve, reject) => {
      openPending.set(requestId, { resolve, reject });
      worker.postMessage({
        type: "open",
        requestId,
        assetId,
        proxyUrl,
      });
    });
  };

  const openedUrls = new Map<string, string>();

  return {
    async open(assetId, proxyUrl) {
      if (openedUrls.get(assetId) === proxyUrl) return;
      await openWithDuration(assetId, proxyUrl);
      openedUrls.set(assetId, proxyUrl);
    },

    openWithDuration: async (assetId, proxyUrl) => {
      if (openedUrls.get(assetId) === proxyUrl) {
        return { durationUs: 0 };
      }
      const info = await openWithDuration(assetId, proxyUrl);
      openedUrls.set(assetId, proxyUrl);
      return info;
    },

    getFrame(assetId, sourceTimeUs, generation) {
      latestGeneration = Math.max(latestGeneration, generation);
      const requestId = nextRequestId++;
      return new Promise<VideoFrame | null>((resolve, reject) => {
        pending.set(requestId, {
          resolve,
          reject,
          generation,
          assetId,
          sourceTimeUs,
        });
        worker.postMessage({
          type: "getFrame",
          requestId,
          assetId,
          sourceTimeUs,
          generation,
        });
      });
    },

    preload(assetId, startTimeUs, endTimeUs) {
      worker.postMessage({
        type: "preload",
        assetId,
        startTimeUs,
        endTimeUs,
      });
    },

    release(assetId) {
      openedUrls.delete(assetId);
      worker.postMessage({ type: "release", assetId });
    },

    dispose() {
      openedUrls.clear();
      for (const p of pending.values()) {
        p.resolve(null);
      }
      pending.clear();
      worker.postMessage({ type: "dispose" });
      worker.terminate();
    },
  };
}

let shared: WorkerFrameProvider | null = null;

const stubProvider: WorkerFrameProvider = {
  async open() {},
  async openWithDuration() {
    return { durationUs: 0 };
  },
  async getFrame() {
    return null;
  },
  preload() {},
  release() {},
  dispose() {},
};

/** Process-wide FrameProvider (one decode worker when WebCodecs is available). */
export function getSharedFrameProvider(): WorkerFrameProvider {
  if (!webCodecsAvailable()) return stubProvider;
  if (!shared) shared = createWorkerFrameProvider();
  return shared;
}
