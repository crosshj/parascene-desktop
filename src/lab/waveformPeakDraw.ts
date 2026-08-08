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

function samplePeakAtNorm(peaks: number[], t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  const srcIdx = clamped * peaks.length;
  const lo = Math.min(peaks.length - 1, Math.floor(srcIdx));
  const hi = Math.min(peaks.length - 1, lo + 1);
  const frac = srcIdx - lo;
  return peaks[lo] * (1 - frac) + peaks[hi] * frac;
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
    out[i] = samplePeakAtNorm(peaks, t);
  }
  return out;
}

/**
 * Source media time for a local timeline position.
 * Mirrors `clipSourceSec` loop / ping-pong mapping for video-linked audio.
 */
export function sourceSecAtLocalTimeline(opts: {
  localSec: number;
  inSec: number;
  outSec: number;
  sourceSpanSec: number;
  speed: number;
  timelineDurSec: number;
  extendPingPong: boolean;
  mapExtendedPlayback: boolean;
}): number {
  const inSec = Math.max(0, opts.inSec);
  const outSec = Math.max(inSec, opts.outSec);
  const sourceSpan = Math.max(0.1, opts.sourceSpanSec);
  const speed =
    Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : 1;
  const local = Math.max(0, opts.localSec);
  const timelineDur = Math.max(0.1, opts.timelineDurSec);
  const playthrough = sourceSpan / speed;
  const mediaLocal = local * speed;

  if (
    !opts.mapExtendedPlayback ||
    mediaLocal <= sourceSpan + 1e-6 ||
    timelineDur <= playthrough + 1e-6
  ) {
    return Math.min(outSec, Math.max(inSec, inSec + mediaLocal));
  }

  const extendMedia = mediaLocal - sourceSpan;
  if (!opts.extendPingPong) {
    return inSec + (extendMedia % sourceSpan);
  }
  const segment = Math.floor(extendMedia / sourceSpan);
  const phase = extendMedia % sourceSpan;
  if (segment % 2 === 0) {
    return outSec - phase;
  }
  return inSec + phase;
}

export type ClipWaveformPlaybackOpts = {
  /** Clip timeline length (end − start). Required for extend-aware sampling. */
  timelineDurSec?: number;
  speed?: number;
  extendPingPong?: boolean;
  /** Frozen trim span used while extended; defaults to out − in. */
  sourceSpanSec?: number;
  /**
   * When true, sample by playback timeline (trim crop, loop, ping-pong)
   * instead of stretching one [in,out] window across the full clip width.
   */
  mapExtendedPlayback?: boolean;
};

/** Sample peaks the way the clip would play across its timeline width. */
export function peaksForPlaybackTimeline(
  peaks: number[],
  sourceDurationSec: number,
  opts: {
    inSec: number;
    outSec: number;
    barCount: number;
    timelineDurSec: number;
    speed?: number;
    extendPingPong?: boolean;
    sourceSpanSec?: number;
    mapExtendedPlayback?: boolean;
  },
): number[] {
  const barCount = opts.barCount;
  if (barCount <= 0 || peaks.length === 0 || sourceDurationSec <= 0) {
    return Array.from({ length: Math.max(0, barCount) }, () => 0);
  }
  const inSec = Math.max(0, opts.inSec);
  const outSec = Math.max(inSec, opts.outSec);
  const sourceSpan = Math.max(0.1, opts.sourceSpanSec ?? outSec - inSec);
  const timelineDur = Math.max(0.1, opts.timelineDurSec);
  const out = new Array<number>(barCount);
  for (let i = 0; i < barCount; i++) {
    const localSec = ((i + 0.5) / barCount) * timelineDur;
    const sourceSec = sourceSecAtLocalTimeline({
      localSec,
      inSec,
      outSec,
      sourceSpanSec: sourceSpan,
      speed: opts.speed ?? 1,
      timelineDurSec: timelineDur,
      extendPingPong: opts.extendPingPong === true,
      mapExtendedPlayback: opts.mapExtendedPlayback === true,
    });
    out[i] = samplePeakAtNorm(peaks, sourceSec / sourceDurationSec);
  }
  return out;
}

/**
 * Stable playthrough peaks + draw-time tiling.
 * `mapExtendedPlayback` does not resample across the full timeline here —
 * that caused the waveform to re-bucket (jitter) on every resize frame.
 */
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
  if (cssW <= 0 || peaks.length === 0) return;
  const mid = cssH / 2;
  const gap = 1;
  const barW = Math.max(0.5, (cssW - gap * (peaks.length - 1)) / peaks.length);
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

export type WaveformStripSeg = {
  destX: number;
  destW: number;
  /** 0..1 into the playthrough stamp. */
  srcStartFrac: number;
  srcEndFrac: number;
  reverse: boolean;
};

/**
 * Pixel ranges to paint when growing a 1:1 timeline strip from `fromCssW` → `toCssW`.
 * Shrink is not listed — callers just reduce the visible width and keep left pixels.
 */
export function waveformStripGrowSegs(opts: {
  fromCssW: number;
  toCssW: number;
  tileCssW: number;
  extendPingPong?: boolean;
}): WaveformStripSeg[] {
  const from = Math.max(0, Math.floor(opts.fromCssW));
  const to = Math.max(0, Math.floor(opts.toCssW));
  const tileW = Math.max(1, Math.round(opts.tileCssW));
  const pingPong = opts.extendPingPong === true;
  if (to <= from) return [];
  const segs: WaveformStripSeg[] = [];
  let x = from;
  while (x < to) {
    const tileIndex = Math.floor(x / tileW);
    const tileStart = tileIndex * tileW;
    const paintEnd = Math.min(to, tileStart + tileW);
    const destW = paintEnd - x;
    if (destW <= 0) break;
    const srcStartFrac = (x - tileStart) / tileW;
    const srcEndFrac = (paintEnd - tileStart) / tileW;
    segs.push({
      destX: x,
      destW,
      srcStartFrac,
      srcEndFrac,
      reverse: pingPong && tileIndex > 0 && tileIndex % 2 === 1,
    });
    x = paintEnd;
  }
  return segs;
}

function stampKey(
  peaks: number[],
  overlay: number[] | null,
  selected: boolean,
): string {
  // Identity for cache invalidation — length + endpoints are enough with layer rebuilds.
  const o = overlay;
  return [
    peaks.length,
    peaks[0] ?? 0,
    peaks[peaks.length - 1] ?? 0,
    o?.length ?? 0,
    o?.[0] ?? 0,
    selected ? 1 : 0,
  ].join(":");
}

export type ClipWaveformStrip = {
  stamp: HTMLCanvasElement | null;
  stampCssW: number;
  stampCssH: number;
  stampDpr: number;
  stampKey: string;
  composed: HTMLCanvasElement | null;
  /** Logical painted width (shrink only reduces this; pixels stay). */
  logicalCssW: number;
  composedCssH: number;
  composedDpr: number;
  tileCssW: number;
  extendPingPong: boolean;
};

export function createClipWaveformStrip(): ClipWaveformStrip {
  return {
    stamp: null,
    stampCssW: 0,
    stampCssH: 0,
    stampDpr: 1,
    stampKey: "",
    composed: null,
    logicalCssW: 0,
    composedCssH: 0,
    composedDpr: 1,
    tileCssW: 0,
    extendPingPong: false,
  };
}

function buildStamp(
  mixPeaks: number[],
  overlayPeaks: number[] | null,
  tileCssW: number,
  cssH: number,
  dpr: number,
  mixStyle: PeakLayerStyle,
  overlayStyle: PeakLayerStyle,
): HTMLCanvasElement | null {
  if (tileCssW <= 0 || cssH <= 0 || mixPeaks.length === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(tileCssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawPeakLayer(ctx, tileCssW, cssH, mixPeaks, 1, mixStyle, true);
  if (overlayPeaks?.length) {
    drawPeakLayer(ctx, tileCssW, cssH, overlayPeaks, 1, overlayStyle, true);
  }
  return canvas;
}

function blitStampSeg(
  ctx: CanvasRenderingContext2D,
  stamp: HTMLCanvasElement,
  stampCssW: number,
  cssH: number,
  dpr: number,
  seg: WaveformStripSeg,
): void {
  if (seg.destW <= 0 || stampCssW <= 0) return;
  const start = Math.min(1, Math.max(0, seg.srcStartFrac));
  const end = Math.min(1, Math.max(start + 1e-6, seg.srcEndFrac));
  const srcW = stampCssW * (end - start);
  // Stamp bars are translucent on a transparent ground — clear first so a
  // mode rebuild (loop ↔ ping-pong) never stacks on stale pixels.
  ctx.clearRect(seg.destX, 0, seg.destW, cssH);
  if (seg.reverse) {
    const srcX = stampCssW * (1 - end);
    ctx.save();
    ctx.beginPath();
    ctx.rect(seg.destX, 0, seg.destW, cssH);
    ctx.clip();
    ctx.translate(seg.destX + seg.destW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(
      stamp,
      srcX * dpr,
      0,
      srcW * dpr,
      stamp.height,
      0,
      0,
      seg.destW,
      cssH,
    );
    ctx.restore();
    return;
  }
  const srcX = stampCssW * start;
  ctx.drawImage(
    stamp,
    srcX * dpr,
    0,
    srcW * dpr,
    stamp.height,
    seg.destX,
    0,
    seg.destW,
    cssH,
  );
}

function ensureComposedCapacity(
  strip: ClipWaveformStrip,
  needCssW: number,
  cssH: number,
  dpr: number,
  opts?: { copyPrev?: boolean },
): CanvasRenderingContext2D | null {
  const needW = Math.max(1, Math.ceil(needCssW * dpr));
  const needH = Math.max(1, Math.ceil(cssH * dpr));
  const prev = strip.composed;
  const copyPrev = opts?.copyPrev !== false;
  if (
    prev &&
    prev.width >= needW &&
    prev.height === needH &&
    strip.composedDpr === dpr
  ) {
    return prev.getContext("2d");
  }
  const next = document.createElement("canvas");
  // Grow with headroom so small drags don't reallocate every frame.
  next.width = Math.max(needW, prev?.width ?? 0, Math.ceil(needCssW * dpr * 1.25));
  next.height = needH;
  const ctx = next.getContext("2d");
  if (!ctx) return null;
  if (
    copyPrev &&
    prev &&
    strip.logicalCssW > 0 &&
    prev.width > 0 &&
    prev.height === needH
  ) {
    ctx.drawImage(prev, 0, 0);
  }
  strip.composed = next;
  strip.composedCssH = cssH;
  strip.composedDpr = dpr;
  return ctx;
}

/**
 * Maintain a 1:1 timeline waveform strip:
 * - shrink → keep left pixels, only reduce visible width
 * - expand → paint only the new right-hand segments from the playthrough stamp
 */
export function syncClipWaveformStrip(
  strip: ClipWaveformStrip,
  opts: {
    mixPeaks: number[];
    overlayPeaks: number[] | null;
    cssH: number;
    dpr: number;
    selected: boolean;
    timelineDurSec: number;
    playthroughSec: number;
    pxPerSec: number;
    extendPingPong: boolean;
  },
): void {
  const cssH = Math.max(1, Math.round(opts.cssH));
  const dpr = opts.dpr > 0 ? opts.dpr : 1;
  const pps = opts.pxPerSec > 0 ? opts.pxPerSec : 1;
  const playthroughSec = Math.max(0.1, opts.playthroughSec);
  const timelineDur = Math.max(0.1, opts.timelineDurSec);
  const tileCssW = Math.max(1, Math.round(playthroughSec * pps));
  const targetCssW = Math.max(1, Math.round(timelineDur * pps));
  const hasOverlay = Boolean(opts.overlayPeaks?.length);
  const mixStyle = opts.selected
    ? hasOverlay
      ? EDITOR_MIX_PEAK_LAYER_SELECTED_WITH_OVERLAY
      : EDITOR_MIX_PEAK_LAYER_SELECTED
    : hasOverlay
      ? EDITOR_MIX_PEAK_LAYER_WITH_OVERLAY
      : EDITOR_MIX_PEAK_LAYER;
  const overlayStyle = opts.selected
    ? EDITOR_VOCALS_OVERLAY_PEAK_LAYER_SELECTED
    : EDITOR_VOCALS_OVERLAY_PEAK_LAYER;
  const key = stampKey(opts.mixPeaks, opts.overlayPeaks, opts.selected);

  const stampDirty =
    !strip.stamp ||
    strip.stampKey !== key ||
    strip.stampCssW !== tileCssW ||
    strip.stampCssH !== cssH ||
    strip.stampDpr !== dpr;

  const layoutDirty =
    strip.tileCssW !== tileCssW ||
    strip.extendPingPong !== opts.extendPingPong ||
    strip.composedCssH !== cssH ||
    strip.composedDpr !== dpr;

  // Ping-pong / zoom / height changes must rebuild the strip from scratch —
  // never paint new tiles over a stale composition (transparent gaps stack).
  const fullRebuild = stampDirty || layoutDirty;

  if (stampDirty) {
    strip.stamp = buildStamp(
      opts.mixPeaks,
      opts.overlayPeaks,
      tileCssW,
      cssH,
      dpr,
      mixStyle,
      overlayStyle,
    );
    strip.stampCssW = tileCssW;
    strip.stampCssH = cssH;
    strip.stampDpr = dpr;
    strip.stampKey = key;
  }

  if (fullRebuild) {
    strip.logicalCssW = 0;
    strip.tileCssW = tileCssW;
    strip.extendPingPong = opts.extendPingPong;
  }

  if (!strip.stamp) return;

  if (!fullRebuild && targetCssW <= strip.logicalCssW) {
    // Shrink: drop the end. Left pixels remain untouched.
    strip.logicalCssW = targetCssW;
    return;
  }

  const ctx = ensureComposedCapacity(strip, targetCssW, cssH, dpr, {
    copyPrev: !fullRebuild,
  });
  if (!ctx || !strip.composed) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (fullRebuild) {
    ctx.clearRect(0, 0, strip.composed.width, strip.composed.height);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const segs = waveformStripGrowSegs({
    fromCssW: strip.logicalCssW,
    toCssW: targetCssW,
    tileCssW,
    extendPingPong: opts.extendPingPong,
  });
  for (const seg of segs) {
    blitStampSeg(ctx, strip.stamp, tileCssW, cssH, dpr, seg);
  }
  strip.logicalCssW = targetCssW;
  strip.extendPingPong = opts.extendPingPong;
  strip.tileCssW = tileCssW;
  strip.composedCssH = cssH;
  strip.composedDpr = dpr;
}

/** Present the strip onto the visible clip canvas (1:1 crop, no rescale). */
export function presentClipWaveformStrip(
  strip: ClipWaveformStrip,
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): void {
  const dpr = strip.composedDpr || window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx || !strip.composed || strip.logicalCssW <= 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const srcW = Math.min(w, strip.logicalCssW);
  ctx.drawImage(
    strip.composed,
    0,
    0,
    srcW * dpr,
    h * dpr,
    0,
    0,
    srcW,
    h,
  );
}

export type WaveformPlaybackTile = {
  startFrac: number;
  endFrac: number;
  reverse: boolean;
  peakEndFrac: number;
};

/** Loop / ping-pong tile layout in clip-normalized coordinates. */
export function waveformPlaybackTiles(opts: {
  timelineDurSec: number;
  playthroughSec: number;
  extendPingPong?: boolean;
}): WaveformPlaybackTile[] {
  const timelineDur = Math.max(0.1, opts.timelineDurSec);
  const playthrough = Math.max(0.1, opts.playthroughSec);
  const pingPong = opts.extendPingPong === true;
  if (timelineDur <= playthrough + 1e-6) {
    return [
      {
        startFrac: 0,
        endFrac: 1,
        reverse: false,
        // Shorter than one playthrough → clip the source window.
        peakEndFrac: Math.min(1, timelineDur / playthrough),
      },
    ];
  }
  const tiles: WaveformPlaybackTile[] = [];
  let startSec = 0;
  let index = 0;
  while (startSec < timelineDur - 1e-6) {
    const endSec = Math.min(timelineDur, startSec + playthrough);
    tiles.push({
      startFrac: startSec / timelineDur,
      endFrac: endSec / timelineDur,
      // First playthrough forward; ping-pong odd tiles reverse.
      reverse: pingPong && index > 0 && index % 2 === 1,
      peakEndFrac: Math.min(1, (endSec - startSec) / playthrough),
    });
    startSec = endSec;
    index += 1;
  }
  return tiles;
}

export type DrawClipAudioWaveformOpts = {
  selected?: boolean;
};

/** Simple full-bleed waveform (Master Audio beds). Linked video audio uses the strip. */
export function drawClipAudioWaveform(
  canvas: HTMLCanvasElement,
  mixPeaks: number[],
  overlayPeaks: number[] | null,
  opts?: DrawClipAudioWaveformOpts,
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
