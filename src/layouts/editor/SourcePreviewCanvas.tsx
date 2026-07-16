import { useEffect, useRef, useState } from "react";
import {
  ensureProxyMediaUrl,
  getCachedProxyUrl,
} from "../../library/proxyMedia";
import {
  getSharedFrameProvider,
  openPreviewVideo,
  PreviewRenderer,
  type FrameTarget,
} from "../../preview";

type SourcePreviewCanvasProps = {
  assetId: string;
  kind: "video" | "image";
  /** Scrub / playhead time in source seconds (forward media space). */
  currentSec: number;
  /** When true, HTML fallback uses native play + blit instead of seek-every-tick. */
  playing?: boolean;
  imageUrl?: string | null;
  onDuration?: (sec: number) => void;
  onReadyChange?: (ready: boolean) => void;
  onError?: (message: string | null) => void;
};

/**
 * Persistent canvas preview for source-monitor video/image.
 */
export function SourcePreviewCanvas({
  assetId,
  kind,
  currentSec,
  playing = false,
  imageUrl,
  onDuration,
  onReadyChange,
  onError,
}: SourcePreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const onDurationRef = useRef(onDuration);
  const onReadyChangeRef = useRef(onReadyChange);
  const onErrorRef = useRef(onError);
  onDurationRef.current = onDuration;
  onReadyChangeRef.current = onReadyChange;
  onErrorRef.current = onError;

  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
    return () => {
      ro.disconnect();
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (kind !== "video") {
      setProxyUrl(null);
      return;
    }
    const openProxy = async (url: string) => {
      const info = await openPreviewVideo(
        assetId,
        url,
        getSharedFrameProvider(),
      );
      onDurationRef.current?.(Math.max(0.1, info.durationUs / 1e6));
      onReadyChangeRef.current?.(true);
      onErrorRef.current?.(null);
      setStatus(null);
    };

    const cached = getCachedProxyUrl(assetId);
    if (cached) {
      setProxyUrl(cached);
      let cancelled = false;
      void openProxy(cached).catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus(message);
        onErrorRef.current?.(message);
        onReadyChangeRef.current?.(false);
      });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;
    setStatus("Building proxy…");
    onReadyChangeRef.current?.(false);
    void ensureProxyMediaUrl(assetId)
      .then(async (url) => {
        if (cancelled) return;
        setProxyUrl(url);
        await openProxy(url);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus(message);
        onErrorRef.current?.(message);
        onReadyChangeRef.current?.(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, kind]);

  useEffect(() => {
    if (kind !== "image") return;
    if (!imageUrl) {
      onReadyChangeRef.current?.(false);
      setStatus("No local media");
      return;
    }
    setStatus(null);
    onReadyChangeRef.current?.(true);
  }, [kind, imageUrl]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    if (kind === "image") {
      if (!imageUrl) return;
      const target: FrameTarget = {
        assetId,
        sourceTimeUs: 0,
        clipId: assetId,
        kind: "image",
      };
      void renderer.renderTarget(target, { imageUrl });
      return;
    }

    if (!proxyUrl) return;
    const target: FrameTarget = {
      assetId,
      sourceTimeUs: Math.round(Math.max(0, currentSec) * 1e6),
      clipId: assetId,
      kind: "video",
    };
    void renderer.renderTarget(target, { proxyUrl, playing });
  }, [assetId, kind, currentSec, proxyUrl, imageUrl, playing]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="editor-preview-media editor-preview-detail editor-preview-canvas"
        aria-label="Source preview"
      />
      {status ? (
        <span className="editor-preview-wait muted">{status}</span>
      ) : null}
    </>
  );
}
