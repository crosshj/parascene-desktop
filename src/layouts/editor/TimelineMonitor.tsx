import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureLocal, getCreation } from "../../library/catalogClient";
import {
  canFetchLocal,
  creationDetailUrl,
  creationPreviewUrl,
  isParasceneUnavailable,
} from "../../library/previewUrl";
import {
  ensureProxyMediaUrl,
  getCachedProxyUrl,
} from "../../library/proxyMedia";
import {
  ensureReversedMedia,
  getCachedReversedMedia,
} from "../../library/reversedMedia";
import type { Creation } from "../../library/types";
import type { TimelineClip } from "../../project/types";
import {
  getSharedFrameProvider,
  pauseAllHtmlVideos,
  PreviewRenderer,
  preloadPreviewVideo,
  webCodecsAvailable,
} from "../../preview";
import {
  peekNextVisualClip,
  resolveFrameTarget,
  resolveSeamPreload,
  resolveTimelineFrame,
  type TimelineLayer,
} from "./timelineCompose";

type TimelineMonitorProps = {
  clips: TimelineClip[];
  playheadSec: number;
  playing: boolean;
  mediaSeekEpoch?: number;
  volume: number;
};

type MediaUrls = {
  detail: string | null;
  thumb: string | null;
  waitingLocal: boolean;
};

function useAssetMedia(assetId: string | null): MediaUrls {
  const [creation, setCreation] = useState<Creation | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [waitingLocal, setWaitingLocal] = useState(false);

  useEffect(() => {
    if (!assetId) {
      setCreation(null);
      return;
    }
    let cancelled = false;
    setDetailFailed(false);
    void getCreation(assetId)
      .then((row) => {
        if (cancelled) return;
        setCreation(row);
        if (
          canFetchLocal(row) &&
          !creationDetailUrl(row) &&
          !creationPreviewUrl(row)
        ) {
          setWaitingLocal(true);
          void ensureLocal([assetId], { fullMedia: true, urgent: true });
        } else {
          setWaitingLocal(false);
        }
      })
      .catch(() => {
        if (!cancelled) setCreation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  useEffect(() => {
    if (!assetId) return;
    let cancelled = false;
    const unlisten = listen<Creation>("library-creation-updated", (event) => {
      if (cancelled) return;
      if (event.payload.id !== assetId) return;
      setCreation(event.payload);
      if (creationDetailUrl(event.payload) || creationPreviewUrl(event.payload)) {
        setWaitingLocal(false);
        setDetailFailed(false);
      }
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [assetId]);

  const detail =
    creation && !detailFailed ? creationDetailUrl(creation) : null;
  const thumb = creation ? creationPreviewUrl(creation) : null;

  return {
    detail,
    thumb,
    waitingLocal:
      waitingLocal ||
      Boolean(
        creation &&
          canFetchLocal(creation) &&
          !detail &&
          !thumb &&
          !isParasceneUnavailable(creation),
      ),
  };
}

function useReversedDetail(
  assetId: string | null,
  enabled: boolean,
  hasLocal: boolean,
): { detail: string | null; busy: boolean } {
  const [detail, setDetail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!enabled || !assetId || !hasLocal) {
      setDetail(null);
      setBusy(false);
      return;
    }
    const cached = getCachedReversedMedia(assetId);
    if (cached) {
      setDetail(cached.mediaUrl);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void ensureReversedMedia(assetId)
      .then((urls) => {
        if (cancelled) return;
        setDetail(urls.mediaUrl);
        setBusy(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, enabled, hasLocal]);

  return { detail, busy };
}

/**
 * Program monitor: persistent canvas + FrameProvider / HTML-video fallback.
 */
export function TimelineMonitor({
  clips,
  playheadSec,
  playing,
  mediaSeekEpoch = 0,
  volume,
}: TimelineMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const htmlFallback = !webCodecsAvailable();

  const frame = resolveTimelineFrame(clips, playheadSec);
  const visual = frame.visual;
  const audioLayer = frame.audio[0] ?? null;
  const audioAssetId = audioLayer?.clip.assetId?.trim() || null;

  const target = useMemo(
    () => resolveFrameTarget(clips, Math.round(playheadSec * 1e6)),
    [clips, playheadSec],
  );

  const visualAssetId = target?.assetId ?? null;
  const media = useAssetMedia(visualAssetId);
  const wantsReverse = Boolean(visual?.clip.reverse && target?.kind === "video");
  const reversed = useReversedDetail(
    visualAssetId,
    wantsReverse && htmlFallback,
    Boolean(media.detail),
  );

  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  /** Media URL for painting: original (HTML) or proxy (WebCodecs). */
  const paintUrl = htmlFallback
    ? wantsReverse
      ? reversed.detail
      : media.detail
    : proxyUrl;

  // A1 owns program audio when present; otherwise play the video soundtrack.
  const videoMuted = Boolean(audioLayer);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new PreviewRenderer(canvas, getSharedFrameProvider());
    rendererRef.current = renderer;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      renderer.resize(entry.contentRect.width, entry.contentRect.height);
    });
    ro.observe(canvas.parentElement ?? canvas);
    // Size immediately from parent box.
    const parent = canvas.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        renderer.resize(rect.width, rect.height);
      }
    }
    return () => {
      ro.disconnect();
      pauseAllHtmlVideos();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  // WebCodecs path needs proxies; HTML path uses originals.
  useEffect(() => {
    if (htmlFallback || !target || target.kind !== "video") {
      setProxyUrl(null);
      setProxyError(null);
      setProxyBusy(false);
      return;
    }
    const cached = getCachedProxyUrl(target.assetId);
    if (cached) {
      setProxyUrl(cached);
      setProxyError(null);
      setProxyBusy(false);
      return;
    }
    let cancelled = false;
    setProxyBusy(true);
    setProxyError(null);
    void ensureProxyMediaUrl(target.assetId)
      .then((url) => {
        if (cancelled) return;
        setProxyUrl(url);
        setProxyBusy(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setProxyBusy(false);
        setProxyError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [htmlFallback, target?.assetId, target?.kind]);

  // Seam preload (best-effort).
  useEffect(() => {
    if (!htmlFallback) {
      const provider = getSharedFrameProvider();
      const seam = resolveSeamPreload(clips, playheadSec);
      const warm = async (
        side: { assetId: string; startTimeUs: number; endTimeUs: number } | null,
      ) => {
        if (!side) return;
        try {
          const url =
            getCachedProxyUrl(side.assetId) ??
            (await ensureProxyMediaUrl(side.assetId));
          preloadPreviewVideo(
            side.assetId,
            url,
            side.startTimeUs,
            side.endTimeUs,
            provider,
          );
        } catch {
          /* ignore */
        }
      };
      void warm(seam.outgoing);
      void warm(seam.incoming);
      const next = peekNextVisualClip(clips, playheadSec);
      if (next?.assetId?.trim() && next.kind !== "image") {
        void warm({
          assetId: next.assetId.trim(),
          startTimeUs: 0,
          endTimeUs: Math.round(0.2 * 1e6),
        });
      }
    }
  }, [htmlFallback, clips, playheadSec, mediaSeekEpoch]);

  // Pause hidden videos when leaving play.
  useEffect(() => {
    if (!playing) pauseAllHtmlVideos();
  }, [playing]);

  // Paint / play.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (!target) {
      setStatus(null);
      if (clips.length === 0) renderer.showEmpty();
      return;
    }

    if (target.kind === "image") {
      const url = media.detail ?? media.thumb;
      if (!url) {
        setStatus(media.waitingLocal ? "Saving locally…" : "No local media");
        return;
      }
      setStatus(null);
      void renderer.renderTarget(target, {
        timelineTimeUs: Math.round(playheadSec * 1e6),
        imageUrl: url,
      });
      return;
    }

    if (htmlFallback) {
      if (wantsReverse && reversed.busy) {
        setStatus("Reversing…");
        return;
      }
      if (!paintUrl) {
        setStatus(media.waitingLocal ? "Saving locally…" : "No local media");
        return;
      }
      setStatus(null);
      // While HTML-playing, only re-enter on asset/seek/play edges — not every
      // playhead tick (blit loop owns frames; seeking every tick kills audio).
      void renderer.renderTarget(target, {
        timelineTimeUs: Math.round(playheadSec * 1e6),
        proxyUrl: paintUrl,
        playing,
        muted: videoMuted,
        volume,
      });
      return;
    }

    if (proxyBusy) {
      setStatus("Building proxy…");
      return;
    }
    if (proxyError) {
      setStatus(proxyError);
      return;
    }
    if (!paintUrl) {
      setStatus(media.waitingLocal ? "Saving locally…" : "Preparing video…");
      return;
    }

    setStatus(null);
    void renderer.renderTarget(target, {
      timelineTimeUs: Math.round(playheadSec * 1e6),
      proxyUrl: paintUrl,
      playing,
    });
  }, [
    target,
    paintUrl,
    proxyBusy,
    proxyError,
    media.detail,
    media.thumb,
    media.waitingLocal,
    // HTML play: ignore continuous playhead; scrub & seek epoch still update.
    htmlFallback && playing ? mediaSeekEpoch : playheadSec,
    mediaSeekEpoch,
    clips.length,
    playing,
    htmlFallback,
    wantsReverse,
    reversed.busy,
    videoMuted,
    volume,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="editor-preview-media editor-preview-detail editor-preview-canvas"
        aria-label="Timeline preview"
      />
      {status ? (
        <span className="editor-preview-wait muted">{status}</span>
      ) : null}
      {audioLayer && audioAssetId ? (
        <AudioLayer
          key={`a:${audioAssetId}:${audioLayer.clip.reverse ? "r" : "f"}`}
          assetId={audioAssetId}
          layer={audioLayer}
          playing={playing}
          mediaSeekEpoch={mediaSeekEpoch}
          volume={volume}
        />
      ) : null}
      {!visual && !audioLayer && !status ? (
        <span className="editor-preview-status muted">Timeline</span>
      ) : null}
    </>
  );
}

function AudioLayer({
  assetId,
  layer,
  playing,
  mediaSeekEpoch,
  volume,
}: {
  assetId: string;
  layer: TimelineLayer;
  playing: boolean;
  mediaSeekEpoch: number;
  volume: number;
}) {
  const media = useAssetMedia(assetId);
  const wantsReverse = Boolean(layer.clip.reverse);
  const reversed = useReversedDetail(
    assetId,
    wantsReverse,
    Boolean(media.detail),
  );
  const src = wantsReverse ? reversed.detail : media.detail;
  const ref = useRef<HTMLAudioElement | null>(null);
  const sourceSecRef = useRef(layer.sourceSec);
  const playingRef = useRef(playing);

  useEffect(() => {
    sourceSecRef.current = layer.sourceSec;
  }, [layer.sourceSec]);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume / 100));
  }, [volume]);

  // Scrub only while paused — never seek every playhead tick while playing.
  useEffect(() => {
    if (!src || playing) return;
    const el = ref.current;
    if (!el) return;
    try {
      if (Math.abs(el.currentTime - layer.sourceSec) > 0.05) {
        el.currentTime = layer.sourceSec;
      }
    } catch {
      /* ignore */
    }
  }, [src, layer.sourceSec, layer.clip.id, playing]);

  // Play / pause / discontinuous seek.
  useEffect(() => {
    if (!src) return;
    const el = ref.current;
    if (!el) return;
    if (!playing) {
      el.pause();
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (Math.abs(el.currentTime - sourceSecRef.current) > 0.15) {
          el.currentTime = sourceSecRef.current;
        }
        if (cancelled || !playingRef.current) return;
        await el.play();
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, playing, layer.clip.id, mediaSeekEpoch]);

  if (wantsReverse && reversed.busy) return null;
  if (!src) return null;

  return (
    <audio
      ref={ref}
      className="editor-preview-audio-el"
      src={src}
      preload="auto"
    />
  );
}
