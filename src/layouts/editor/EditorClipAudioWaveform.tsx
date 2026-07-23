import { useCallback, useEffect, useRef, useState } from "react";
import { audioWaveformPeaks, type WaveformPeaks } from "../../lab/audioTools";
import {
  drawClipAudioWaveform,
  prepareClipWaveformLayers,
} from "../../lab/waveformPeakDraw";

const BAR_W = 2;
const BAR_GAP = 2;

function barCountForWidth(widthPx: number): number {
  return Math.max(12, Math.floor((widthPx - 8) / (BAR_W + BAR_GAP)));
}

export function EditorClipAudioWaveform({
  mixPath,
  overlayPath = null,
  widthPx,
  inSec,
  outSec,
  reversed = false,
  selected = false,
}: {
  mixPath: string;
  overlayPath?: string | null;
  widthPx: number;
  inSec: number;
  outSec: number;
  reversed?: boolean;
  selected?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mixRef = useRef<WaveformPeaks | null>(null);
  const overlayRef = useRef<WaveformPeaks | null>(null);
  const layersRef = useRef<{ mix: number[]; overlay: number[] | null } | null>(
    null,
  );

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
    void (async () => {
      try {
        const mix = await audioWaveformPeaks(mixPath, 256);
        if (cancelled) return;
        setMixData(mix);
        if (!overlayPath) {
          setOverlayData(null);
          return;
        }
        try {
          const overlay = await audioWaveformPeaks(overlayPath, 256);
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
      barCountForWidth(widthPx),
      reversed,
    );
  }, [inSec, outSec, reversed, widthPx]);

  useEffect(() => {
    rebuildLayers();
  }, [mixData, overlayData, rebuildLayers]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const layers = layersRef.current;
    if (!canvas || !layers?.mix.length) return;
    drawClipAudioWaveform(canvas, layers.mix, layers.overlay, { selected });
  }, [selected]);

  useEffect(() => {
    redraw();
  }, [mixData, overlayData, redraw, widthPx, inSec, outSec, reversed, selected]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mixData) return;
    const ro = new ResizeObserver(() => {
      rebuildLayers();
      redraw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [mixData, rebuildLayers, redraw]);

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
