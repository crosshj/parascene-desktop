import type { WaveformPeaks } from "./audioTools";

export type PeakLayerStyle = {
  played: string;
  unplayed: string;
};

export const MIX_PEAK_LAYER: PeakLayerStyle = {
  played: "rgba(168, 85, 247, 0.95)",
  unplayed: "rgba(138, 180, 255, 0.55)",
};

export const MIX_PEAK_LAYER_WITH_OVERLAY: PeakLayerStyle = {
  played: "rgba(138, 180, 255, 0.42)",
  unplayed: "rgba(138, 180, 255, 0.26)",
};

export const VOCALS_OVERLAY_PEAK_LAYER: PeakLayerStyle = {
  played: "rgba(68, 108, 198, 0.95)",
  unplayed: "rgba(68, 108, 198, 0.58)",
};

export const EDITOR_MIX_PEAK_LAYER: PeakLayerStyle = {
  played: "rgba(216, 180, 254, 0.55)",
  unplayed: "rgba(216, 180, 254, 0.55)",
};

export const EDITOR_MIX_PEAK_LAYER_WITH_OVERLAY: PeakLayerStyle = {
  played: "rgba(216, 180, 254, 0.32)",
  unplayed: "rgba(216, 180, 254, 0.32)",
};

export const EDITOR_VOCALS_OVERLAY_PEAK_LAYER: PeakLayerStyle = {
  played: "rgba(68, 108, 198, 0.85)",
  unplayed: "rgba(68, 108, 198, 0.85)",
};

export const EDITOR_MIX_PEAK_LAYER_SELECTED: PeakLayerStyle = {
  played: "rgba(196, 181, 253, 0.72)",
  unplayed: "rgba(196, 181, 253, 0.72)",
};

export const EDITOR_MIX_PEAK_LAYER_SELECTED_WITH_OVERLAY: PeakLayerStyle = {
  played: "rgba(196, 181, 253, 0.4)",
  unplayed: "rgba(196, 181, 253, 0.4)",
};

export const EDITOR_VOCALS_OVERLAY_PEAK_LAYER_SELECTED: PeakLayerStyle = {
  played: "rgba(88, 128, 218, 0.95)",
  unplayed: "rgba(88, 128, 218, 0.95)",
};

export function resamplePeaks(peaks: number[], targetLength: number): number[] {
  if (targetLength <= 0) return [];
  if (peaks.length === targetLength) return peaks;
  if (peaks.length === 0) return Array.from({ length: targetLength }, () => 0);
  const out = new Array<number>(targetLength);
  for (let i = 0; i < targetLength; i++) {
    const t = (i + 0.5) / targetLength;
    const srcIdx = t * peaks.length;
    const lo = Math.min(peaks.length - 1, Math.floor(srcIdx));
    const hi = Math.min(peaks.length - 1, lo + 1);
    const frac = srcIdx - lo;
    out[i] = peaks[lo] * (1 - frac) + peaks[hi] * frac;
  }
  return out;
}

export function waveformAmplitudeMax(result: { amplitudeMax?: number }): number {
  const max = result.amplitudeMax;
  if (typeof max === "number" && Number.isFinite(max) && max > 0) return max;
  return 1;
}

export function sharedWaveformAmplitudeMax(
  mix: { amplitudeMax?: number },
  overlay: { amplitudeMax?: number },
): number {
  return Math.max(
    waveformAmplitudeMax(mix),
    waveformAmplitudeMax(overlay),
    1e-6,
  );
}

export function peaksOnSharedAmplitudeScale(
  peaks: number[],
  amplitudeMax: number,
  sharedMax: number,
): number[] {
  const scale = amplitudeMax / sharedMax;
  return peaks.map((peak) => peak * scale);
}

/** Map a source-time window onto `barCount` waveform bars. */
export function peaksForClipWindow(
  peaks: number[],
  sourceDurationSec: number,
  inSec: number,
  outSec: number,
  barCount: number,
): number[] {
  if (barCount <= 0 || peaks.length === 0 || sourceDurationSec <= 0) {
    return Array.from({ length: Math.max(0, barCount) }, () => 0);
  }
  const start = Math.max(0, inSec) / sourceDurationSec;
  const end = Math.max(start, outSec) / sourceDurationSec;
  const out = new Array<number>(barCount);
  const span = end - start;
  for (let i = 0; i < barCount; i++) {
    const t = start + ((i + 0.5) / barCount) * span;
    const srcIdx = t * peaks.length;
    const lo = Math.min(peaks.length - 1, Math.floor(srcIdx));
    const hi = Math.min(peaks.length - 1, lo + 1);
    const frac = srcIdx - lo;
    out[i] = peaks[lo] * (1 - frac) + peaks[hi] * frac;
  }
  return out;
}

export function prepareClipWaveformLayers(
  mix: WaveformPeaks,
  overlay: WaveformPeaks | null,
  inSec: number,
  outSec: number,
  barCount: number,
  reversed = false,
): { mix: number[]; overlay: number[] | null } {
  const mixWindow = peaksForClipWindow(
    mix.peaks,
    mix.durationSec,
    inSec,
    outSec,
    barCount,
  );
  if (!overlay) {
    const ordered = reversed ? [...mixWindow].reverse() : mixWindow;
    return { mix: ordered, overlay: null };
  }
  const overlayWindow = peaksForClipWindow(
    overlay.peaks,
    overlay.durationSec,
    inSec,
    outSec,
    barCount,
  );
  const sharedMax = sharedWaveformAmplitudeMax(mix, overlay);
  const mixScaled = peaksOnSharedAmplitudeScale(
    mixWindow,
    waveformAmplitudeMax(mix),
    sharedMax,
  );
  const overlayScaled = peaksOnSharedAmplitudeScale(
    overlayWindow,
    waveformAmplitudeMax(overlay),
    sharedMax,
  );
  if (reversed) {
    return {
      mix: [...mixScaled].reverse(),
      overlay: [...overlayScaled].reverse(),
    };
  }
  return { mix: mixScaled, overlay: overlayScaled };
}

export function prepareOverlaidWaveformPeaks(
  mix: WaveformPeaks,
  overlay: WaveformPeaks,
): { mix: number[]; overlay: number[] } {
  const sharedMax = sharedWaveformAmplitudeMax(mix, overlay);
  const mixScaled = peaksOnSharedAmplitudeScale(
    mix.peaks,
    waveformAmplitudeMax(mix),
    sharedMax,
  );
  const overlayScaled = peaksOnSharedAmplitudeScale(
    resamplePeaks(overlay.peaks, mix.peaks.length),
    waveformAmplitudeMax(overlay),
    sharedMax,
  );
  return { mix: mixScaled, overlay: overlayScaled };
}

function drawPeakLayer(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  peaks: number[],
  progress: number,
  style: PeakLayerStyle,
  uniformColor = false,
): void {
  const mid = cssH / 2;
  const gap = 1;
  const barW = Math.max(1, (cssW - gap * (peaks.length - 1)) / peaks.length);
  const playedBars = Math.floor(progress * peaks.length);

  peaks.forEach((p, i) => {
    const h = Math.max(2, p * (cssH * 0.9));
    const x = i * (barW + gap);
    const y = mid - h / 2;
    ctx.fillStyle = uniformColor
      ? style.unplayed
      : i <= playedBars
        ? style.played
        : style.unplayed;
    ctx.fillRect(x, y, barW, h);
  });
}

export function drawClipAudioWaveform(
  canvas: HTMLCanvasElement,
  mixPeaks: number[],
  overlayPeaks: number[] | null,
  opts?: { selected?: boolean },
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 40;
  if (cssW <= 0 || cssH <= 0) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const hasOverlay = Boolean(overlayPeaks?.length);
  const selected = opts?.selected === true;
  const mixStyle = selected
    ? hasOverlay
      ? EDITOR_MIX_PEAK_LAYER_SELECTED_WITH_OVERLAY
      : EDITOR_MIX_PEAK_LAYER_SELECTED
    : hasOverlay
      ? EDITOR_MIX_PEAK_LAYER_WITH_OVERLAY
      : EDITOR_MIX_PEAK_LAYER;
  const overlayStyle = selected
    ? EDITOR_VOCALS_OVERLAY_PEAK_LAYER_SELECTED
    : EDITOR_VOCALS_OVERLAY_PEAK_LAYER;

  drawPeakLayer(ctx, cssW, cssH, mixPeaks, 1, mixStyle, true);
  if (overlayPeaks?.length) {
    drawPeakLayer(ctx, cssW, cssH, overlayPeaks, 1, overlayStyle, true);
  }
}

export function drawScrubberWaveform(
  canvas: HTMLCanvasElement,
  peaks: number[],
  progress: number,
  range?: { start: number; end: number } | null,
  overlayPeaks?: number[] | null,
): void {
  const clamp = (n: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n));

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 48;
  if (cssW <= 0 || cssH <= 0) return;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (range && range.end > range.start) {
    const x0 = clamp(range.start, 0, 1) * cssW;
    const x1 = clamp(range.end, 0, 1) * cssW;
    ctx.fillStyle = "rgba(168, 85, 247, 0.18)";
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), cssH);
    ctx.strokeStyle = "rgba(168, 85, 247, 0.9)";
    ctx.lineWidth = 1.5;
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssH);
      ctx.stroke();
    }
  }

  const hasOverlay = Boolean(overlayPeaks?.length);
  drawPeakLayer(
    ctx,
    cssW,
    cssH,
    peaks,
    progress,
    hasOverlay ? MIX_PEAK_LAYER_WITH_OVERLAY : MIX_PEAK_LAYER,
  );
  if (overlayPeaks?.length) {
    drawPeakLayer(
      ctx,
      cssW,
      cssH,
      overlayPeaks,
      progress,
      VOCALS_OVERLAY_PEAK_LAYER,
    );
  }

  const headX = clamp(progress, 0, 1) * cssW;
  ctx.strokeStyle = "#e9d5ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(headX, 0);
  ctx.lineTo(headX, cssH);
  ctx.stroke();

  ctx.fillStyle = "#e9d5ff";
  ctx.beginPath();
  ctx.arc(headX, 4, 4, 0, Math.PI * 2);
  ctx.fill();
}
