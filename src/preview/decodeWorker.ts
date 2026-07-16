/**
 * Web Worker: Mediabunny demux + WebCodecs VideoDecoder.
 * Owns per-asset sessions, decode-from-keyframe, and a bounded frame cache.
 * Returns cloned VideoFrames to the main thread (transferable).
 */

import {
  ALL_FORMATS,
  EncodedPacketSink,
  Input,
  UrlSource,
  type EncodedPacket,
  type InputVideoTrack,
} from "mediabunny";
import { FrameCache } from "./frameCache";

type OpenMsg = {
  type: "open";
  requestId: number;
  assetId: string;
  proxyUrl: string;
};

type GetFrameMsg = {
  type: "getFrame";
  requestId: number;
  assetId: string;
  sourceTimeUs: number;
  generation: number;
};

type PreloadMsg = {
  type: "preload";
  assetId: string;
  startTimeUs: number;
  endTimeUs: number;
};

type ReleaseMsg = {
  type: "release";
  assetId: string;
};

type DisposeMsg = {
  type: "dispose";
};

type InMsg = OpenMsg | GetFrameMsg | PreloadMsg | ReleaseMsg | DisposeMsg;

type FrameMeta = {
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

type OpenOk = {
  type: "openOk";
  requestId: number;
  assetId: string;
  durationUs: number;
};

type ErrMsg = {
  type: "error";
  requestId: number;
  message: string;
};

type AssetSession = {
  assetId: string;
  proxyUrl: string;
  input: Input;
  track: InputVideoTrack;
  sink: EncodedPacketSink;
  decoderConfig: VideoDecoderConfig;
  decoder: VideoDecoder | null;
  /** Last continuous decode cursor (µs) — used to decide reset. */
  lastDecodeUs: number | null;
  decodeQueue: Promise<void>;
};

const cache = new FrameCache(48);
const sessions = new Map<string, AssetSession>();

/** Half-frame at 30fps. */
const FRAME_TOLERANCE_US = Math.round((1 / 60) * 1e6);

function post(msg: FrameMeta | OpenOk | ErrMsg, transfer?: Transferable[]) {
  postMessage(msg, transfer && transfer.length > 0 ? { transfer } : undefined);
}

async function openAsset(assetId: string, proxyUrl: string): Promise<AssetSession> {
  const existing = sessions.get(assetId);
  if (existing && existing.proxyUrl === proxyUrl) return existing;
  if (existing) {
    await disposeSession(existing);
    sessions.delete(assetId);
  }

  const input = new Input({
    source: new UrlSource(proxyUrl),
    formats: ALL_FORMATS,
  });
  const track = await input.getPrimaryVideoTrack();
  if (!track) {
    await input.dispose();
    throw new Error("Proxy has no video track");
  }
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) {
    await input.dispose();
    throw new Error("Could not read video decoder config from proxy");
  }

  if (typeof VideoDecoder === "undefined") {
    await input.dispose();
    throw new Error("WebCodecs VideoDecoder is not available in this WebView");
  }

  const support = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!support.supported) {
    await input.dispose();
    throw new Error(
      "This WebView cannot decode the preview proxy format (H.264). Update macOS / WebView.",
    );
  }

  const sink = new EncodedPacketSink(track);
  const session: AssetSession = {
    assetId,
    proxyUrl,
    input,
    track,
    sink,
    decoderConfig,
    decoder: null,
    lastDecodeUs: null,
    decodeQueue: Promise.resolve(),
  };
  sessions.set(assetId, session);
  return session;
}

async function disposeSession(session: AssetSession): Promise<void> {
  try {
    session.decoder?.close();
  } catch {
    /* ignore */
  }
  session.decoder = null;
  try {
    await session.input.dispose();
  } catch {
    /* ignore */
  }
  cache.releaseAsset(session.assetId);
}

function ensureDecoder(session: AssetSession): VideoDecoder {
  if (session.decoder && session.decoder.state !== "closed") {
    return session.decoder;
  }
  // Placeholder — reconfigured per decode job with a fresh output handler.
  const decoder = new VideoDecoder({
    output: () => {},
    error: () => {},
  });
  decoder.configure(session.decoderConfig);
  session.decoder = decoder;
  return decoder;
}

function resetDecoder(session: AssetSession): void {
  try {
    session.decoder?.close();
  } catch {
    /* ignore */
  }
  session.decoder = null;
  session.lastDecodeUs = null;
}

/**
 * Decode from the keyframe at-or-before target until we have a covering frame.
 * Never returns the first keyframe merely because the target is not ready.
 */
async function decodeCoveringFrame(
  session: AssetSession,
  targetUs: number,
): Promise<{ frame: VideoFrame; keyframeUs: number } | null> {
  const targetSec = targetUs / 1e6;
  const keyPacket = await session.sink.getKeyPacket(targetSec);
  if (!keyPacket) return null;
  const keyframeUs = Math.round(keyPacket.timestamp * 1e6);

  const discontinuous =
    session.lastDecodeUs === null ||
    targetUs < session.lastDecodeUs - FRAME_TOLERANCE_US ||
    targetUs > (session.lastDecodeUs ?? 0) + 2_000_000;

  if (discontinuous) {
    resetDecoder(session);
  }

  const collected: VideoFrame[] = [];
  let decodeError: Error | null = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      collected.push(frame);
    },
    error: (err) => {
      decodeError = err instanceof Error ? err : new Error(String(err));
    },
  });
  decoder.configure(session.decoderConfig);
  try {
    session.decoder?.close();
  } catch {
    /* ignore */
  }
  session.decoder = decoder;

  let packet: EncodedPacket | null = keyPacket;
  let sawPastTarget = false;
  while (packet) {
    decoder.decode(packet.toEncodedVideoChunk());
    if (packet.timestamp >= targetSec - 1e-4) {
      sawPastTarget = true;
      // Decode a few more for B-frame reordering / covering duration.
      let extra = 0;
      let next = await session.sink.getNextPacket(packet);
      while (next && extra < 4) {
        decoder.decode(next.toEncodedVideoChunk());
        packet = next;
        next = await session.sink.getNextPacket(next);
        extra += 1;
      }
      break;
    }
    packet = await session.sink.getNextPacket(packet);
  }

  await decoder.flush();
  if (decodeError) {
    for (const f of collected) f.close();
    throw decodeError;
  }
  if (collected.length === 0) return null;

  // Prefer the latest frame with presentation time <= target (+tol); else closest.
  let bestIdx = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < collected.length; i++) {
    const ts = collected[i]!.timestamp;
    const notAfter = ts <= targetUs + FRAME_TOLERANCE_US;
    // Lower is better: prefer not-after frames, then maximize ts among them,
    // else minimize absolute distance.
    const score = notAfter
      ? -1e15 + (targetUs - ts)
      : Math.abs(ts - targetUs) + 1e15;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const best = collected[bestIdx]!;
  for (let i = 0; i < collected.length; i++) {
    if (i !== bestIdx) {
      try {
        collected[i]!.close();
      } catch {
        /* ignore */
      }
    }
  }

  // If we never decoded past the target and the best frame is the keyframe
  // while the target is clearly later, reject (do not flash first frame).
  if (
    !sawPastTarget &&
    Math.abs(best.timestamp - keyframeUs) < FRAME_TOLERANCE_US &&
    targetUs - keyframeUs > FRAME_TOLERANCE_US * 2
  ) {
    best.close();
    return null;
  }

  session.lastDecodeUs = targetUs;
  return { frame: best, keyframeUs };
}

async function getFrameForAsset(
  assetId: string,
  sourceTimeUs: number,
  generation: number,
  requestId: number,
): Promise<void> {
  const session = sessions.get(assetId);
  if (!session) {
    post({
      type: "error",
      requestId,
      message: `Asset not open: ${assetId}`,
    });
    return;
  }

  const t0 = performance.now();
  const near = cache.findNearest(assetId, sourceTimeUs, FRAME_TOLERANCE_US);
  if (near) {
    const clone = near.frame.clone();
    post(
      {
        type: "frame",
        requestId,
        assetId,
        generation,
        requestedSourceTimeUs: sourceTimeUs,
        returnedFrameTimeUs: near.timestampUs,
        keyframeTimeUs: null,
        decodeDurationMs: performance.now() - t0,
        cacheHit: true,
        liveCachedFrames: cache.size,
        frame: clone,
      },
      [clone],
    );
    return;
  }

  // Serialize decodes per asset so we do not thrash the decoder.
  const run = session.decodeQueue.then(async () => {
    const decoded = await decodeCoveringFrame(session, sourceTimeUs);
    if (!decoded) {
      post({
        type: "error",
        requestId,
        message: `No frame for ${assetId} @ ${sourceTimeUs}µs`,
      });
      return;
    }
    const { frame, keyframeUs } = decoded;
    const timestampUs = frame.timestamp;
    // Cache a clone; transfer another clone to main.
    const cached = frame.clone();
    cache.set(assetId, timestampUs, cached);
    const outbound = frame.clone();
    frame.close();
    post(
      {
        type: "frame",
        requestId,
        assetId,
        generation,
        requestedSourceTimeUs: sourceTimeUs,
        returnedFrameTimeUs: timestampUs,
        keyframeTimeUs: keyframeUs,
        decodeDurationMs: performance.now() - t0,
        cacheHit: false,
        liveCachedFrames: cache.size,
        frame: outbound,
      },
      [outbound],
    );
  });

  session.decodeQueue = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    post({
      type: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function preloadRange(
  assetId: string,
  startTimeUs: number,
  endTimeUs: number,
): Promise<void> {
  const session = sessions.get(assetId);
  if (!session) return;
  const lo = Math.min(startTimeUs, endTimeUs);
  const hi = Math.max(startTimeUs, endTimeUs);
  cache.retainRange(assetId, lo - 500_000, hi + 500_000);

  // Sample ~every 2 frames at 30fps across the window (cap work).
  const step = Math.round((2 / 30) * 1e6);
  const times: number[] = [];
  for (let t = lo; t <= hi; t += step) times.push(t);
  if (times[times.length - 1] !== hi) times.push(hi);
  const limited = times.slice(0, 12);

  for (const t of limited) {
    if (cache.findNearest(assetId, t, FRAME_TOLERANCE_US)) continue;
    try {
      const decoded = await decodeCoveringFrame(session, t);
      if (!decoded) continue;
      cache.set(assetId, decoded.frame.timestamp, decoded.frame);
    } catch {
      /* best-effort preload */
    }
  }
}

self.onmessage = (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.type) {
        case "open": {
          const session = await openAsset(msg.assetId, msg.proxyUrl);
          ensureDecoder(session);
          const durationSec = await session.track.computeDuration();
          const durationUs = Math.round(
            (Number.isFinite(durationSec) ? durationSec : 0) * 1e6,
          );
          post({
            type: "openOk",
            requestId: msg.requestId,
            assetId: msg.assetId,
            durationUs,
          });
          break;
        }
        case "getFrame": {
          await getFrameForAsset(
            msg.assetId,
            msg.sourceTimeUs,
            msg.generation,
            msg.requestId,
          );
          break;
        }
        case "preload": {
          await preloadRange(msg.assetId, msg.startTimeUs, msg.endTimeUs);
          break;
        }
        case "release": {
          const session = sessions.get(msg.assetId);
          if (session) {
            await disposeSession(session);
            sessions.delete(msg.assetId);
          } else {
            cache.releaseAsset(msg.assetId);
          }
          break;
        }
        case "dispose": {
          for (const session of sessions.values()) {
            await disposeSession(session);
          }
          sessions.clear();
          cache.clear();
          break;
        }
        default:
          break;
      }
    } catch (err) {
      const requestId =
        "requestId" in msg && typeof msg.requestId === "number"
          ? msg.requestId
          : -1;
      post({
        type: "error",
        requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
