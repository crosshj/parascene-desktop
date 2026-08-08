import { useCallback, useEffect, useRef, useState } from "react";
import { audioWaveformPeaks, type WaveformPeaks } from "../../lab/audioTools";
import {
  createClipWaveformStrip,
  drawClipAudioWaveform,
  prepareClipWaveformLayers,
  presentClipWaveformStrip,
  syncClipWaveformStrip,
  type ClipWaveformStrip,
} from "../../lab/waveformPeakDraw";

/**
 * Peak samples for one playthrough stamp. Draw-time uses fixed 1px columns;
 * keep this high enough that wide / zoomed stamps stay detailed.
 */
const WAVEFORM_BARS = 512;

export function EditorClipAudioWaveform({
  mixPath,
  overlayPath = null,
  widthPx,
  inSec,
  outSec,
  reversed = false,
  selected = false,
  timelineDurSec,
  speed = 1,
  extendPingPong = false,
  sourceSpanSec,
  mapExtendedPlayback = false,
}: {
  mixPath: string;
  overlayPath?: string | null;
  widthPx: number;
  inSec: number;
  outSec: number;
  reversed?: boolean;
  selected?: boolean;
  timelineDurSec?: number;
  speed?: number;
  extendPingPong?: boolean;
  sourceSpanSec?: number;
  /** Video-linked companions: crop / loop / ping-pong strip. */
  mapExtendedPlayback?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mixRef = useRef<WaveformPeaks | null>(null);
  const overlayRef = useRef<WaveformPeaks | null>(null);
  const layersRef = useRef<{ mix: number[]; overlay: number[] | null } | null>(
    null,
  );
  const stripRef = useRef<ClipWaveformStrip>(createClipWaveformStrip());

  const [mixData, setMixData] = useState<WaveformPeaks | null>(null);
  const [overlayData, setOverlayData] = useState<WaveformPeaks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mixRef.current = mixData;
  }, [mixData]);

  useEffect(() => {
    overlayRef.current = overlayData;
  }, [overlayData]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMixData(null);
    setOverlayData(null);
    setError(null);
    // New media → drop incremental strip.
    stripRef.current = createClipWaveformStrip();
    void (async () => {
      try {
        const mix = await audioWaveformPeaks(mixPath, 512);
        if (cancelled) return;
        setMixData(mix);
        if (!overlayPath) {
          setOverlayData(null);
          return;
        }
        try {
          const overlay = await audioWaveformPeaks(overlayPath, 512);
          if (!cancelled) setOverlayData(overlay);
        } catch {
          if (!cancelled) setOverlayData(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mixPath, overlayPath]);

  const resolvedTimelineDur =
    timelineDurSec ?? Math.max(0.1, outSec - inSec);
  const trimSpan = Math.max(0.1, outSec - inSec);
  const resolvedSourceSpan =
    Number.isFinite(sourceSpanSec) && Number(sourceSpanSec) > 0
      ? Math.max(0.1, Number(sourceSpanSec))
      : trimSpan;
  const safeSpeed =
    Number.isFinite(speed) && speed > 0 ? Math.min(8, Math.max(0.25, speed)) : 1;
  const playthroughSec = resolvedSourceSpan / safeSpeed;

  const rebuildLayers = useCallback(() => {
    const mix = mixRef.current;
    if (!mix) {
      layersRef.current = null;
      return;
    }
    layersRef.current = prepareClipWaveformLayers(
      mix,
      overlayRef.current,
      inSec,
      outSec,
      WAVEFORM_BARS,
      reversed,
    );
    // Trim / reverse change invalidates the stamp strip.
    stripRef.current = createClipWaveformStrip();
  }, [inSec, outSec, reversed]);

  useEffect(() => {
    rebuildLayers();
  }, [mixData, overlayData, rebuildLayers]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const layers = layersRef.current;
    if (!canvas || !layers?.mix.length) return;
    const cssH = canvas.clientHeight || 40;
    const cssW = Math.max(1, widthPx);

    if (mapExtendedPlayback) {
      const pxPerSec = cssW / Math.max(0.1, resolvedTimelineDur);
      syncClipWaveformStrip(stripRef.current, {
        mixPeaks: layers.mix,
        overlayPeaks: layers.overlay,
        cssH,
        dpr: window.devicePixelRatio || 1,
        selected,
        timelineDurSec: resolvedTimelineDur,
        playthroughSec,
        pxPerSec,
        extendPingPong,
      });
      presentClipWaveformStrip(stripRef.current, canvas, cssW, cssH);
      return;
    }

    drawClipAudioWaveform(canvas, layers.mix, layers.overlay, { selected });
  }, [
    selected,
    mapExtendedPlayback,
    resolvedTimelineDur,
    playthroughSec,
    extendPingPong,
    widthPx,
  ]);

  useEffect(() => {
    redraw();
  }, [mixData, overlayData, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mixData) return;
    const ro = new ResizeObserver(() => {
      redraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [mixData, redraw]);

  if (error) {
    return (
      <div className="editor-timeline-clip-wave is-error muted" aria-hidden>
        Waveform unavailable
      </div>
    );
  }

  if (!mixData) {
    return (
      <div className="editor-timeline-clip-wave is-loading muted" aria-hidden>
        …
      </div>
    );
  }

  return (
    <div className="editor-timeline-clip-wave" aria-hidden>
      <canvas
        ref={canvasRef}
        className="editor-timeline-clip-wave-canvas"
      />
    </div>
  );
}
