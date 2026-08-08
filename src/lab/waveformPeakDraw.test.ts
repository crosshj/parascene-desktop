import { describe, expect, it } from "vitest";
import {
  peaksForClipWindow,
  peaksForPlaybackTimeline,
  prepareClipWaveformLayers,
  sourceSecAtLocalTimeline,
  waveformBarCountForWidth,
  waveformPlaybackTiles,
  waveformStripGrowSegs,
} from "./waveformPeakDraw";

describe("waveformBarCountForWidth", () => {
  it("uses fixed 1px bars with 1px gaps", () => {
    expect(waveformBarCountForWidth(0)).toBe(1);
    expect(waveformBarCountForWidth(1)).toBe(1);
    expect(waveformBarCountForWidth(2)).toBe(1);
    expect(waveformBarCountForWidth(3)).toBe(2);
    expect(waveformBarCountForWidth(100)).toBe(50);
  });
});

describe("peaksForClipWindow", () => {
  it("samples the requested source-time range", () => {
    const peaks = [0, 0.25, 0.5, 0.75, 1];
    const window = peaksForClipWindow(peaks, 10, 2, 8, 4);
    expect(window).toHaveLength(4);
    expect(window[0]).toBeLessThan(window[3]);
  });
});

describe("sourceSecAtLocalTimeline / peaksForPlaybackTimeline", () => {
  it("crops to the active local window instead of stretching the full trim", () => {
    // Rising ramp over 4s; clip shows only the first 2s of a 2s placement.
    const peaks = [0, 0.25, 0.5, 0.75, 1];
    const cropped = peaksForPlaybackTimeline(peaks, 4, {
      inSec: 0,
      outSec: 4,
      barCount: 4,
      timelineDurSec: 2,
      mapExtendedPlayback: true,
    });
    const stretched = peaksForClipWindow(peaks, 4, 0, 4, 4);
    expect(cropped[cropped.length - 1]!).toBeLessThan(stretched[stretched.length - 1]!);
  });

  it("tiles loop repeats instead of stretching one playthrough", () => {
    const a = sourceSecAtLocalTimeline({
      localSec: 0.5,
      inSec: 0,
      outSec: 2,
      sourceSpanSec: 2,
      speed: 1,
      timelineDurSec: 6,
      extendPingPong: false,
      mapExtendedPlayback: true,
    });
    const b = sourceSecAtLocalTimeline({
      localSec: 2.5,
      inSec: 0,
      outSec: 2,
      sourceSpanSec: 2,
      speed: 1,
      timelineDurSec: 6,
      extendPingPong: false,
      mapExtendedPlayback: true,
    });
    expect(a).toBeCloseTo(0.5);
    expect(b).toBeCloseTo(0.5);
  });

  it("ping-pongs source time on reverse extend segments", () => {
    expect(
      sourceSecAtLocalTimeline({
        localSec: 2.5,
        inSec: 0,
        outSec: 2,
        sourceSpanSec: 2,
        speed: 1,
        timelineDurSec: 6,
        extendPingPong: true,
        mapExtendedPlayback: true,
      }),
    ).toBeCloseTo(1.5);
  });
});

describe("waveformPlaybackTiles", () => {
  it("clips a short timeline to the start of one playthrough", () => {
    const tiles = waveformPlaybackTiles({
      timelineDurSec: 1,
      playthroughSec: 2,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.peakEndFrac).toBeCloseTo(0.5);
    expect(tiles[0]!.reverse).toBe(false);
  });

  it("keeps the first playthrough tile and appends loop tiles", () => {
    const tiles = waveformPlaybackTiles({
      timelineDurSec: 5,
      playthroughSec: 2,
    });
    expect(tiles).toHaveLength(3);
    expect(tiles[0]!.startFrac).toBe(0);
    expect(tiles[0]!.endFrac).toBeCloseTo(0.4);
    expect(tiles[0]!.peakEndFrac).toBe(1);
    expect(tiles[1]!.reverse).toBe(false);
    expect(tiles[2]!.peakEndFrac).toBeCloseTo(0.5);
  });

  it("marks odd ping-pong tiles as reversed", () => {
    const tiles = waveformPlaybackTiles({
      timelineDurSec: 6,
      playthroughSec: 2,
      extendPingPong: true,
    });
    expect(tiles.map((t) => t.reverse)).toEqual([false, true, false]);
  });
});

describe("waveformStripGrowSegs", () => {
  it("returns nothing when shrinking", () => {
    expect(
      waveformStripGrowSegs({ fromCssW: 200, toCssW: 150, tileCssW: 100 }),
    ).toEqual([]);
  });

  it("appends only the new right-hand pixels when expanding", () => {
    const segs = waveformStripGrowSegs({
      fromCssW: 100,
      toCssW: 250,
      tileCssW: 100,
      extendPingPong: true,
    });
    expect(segs).toEqual([
      {
        destX: 100,
        destW: 100,
        srcStartFrac: 0,
        srcEndFrac: 1,
        reverse: true,
      },
      {
        destX: 200,
        destW: 50,
        srcStartFrac: 0,
        srcEndFrac: 0.5,
        reverse: false,
      },
    ]);
  });

  it("covers the full strip when rebuilding from zero after a mode change", () => {
    const segs = waveformStripGrowSegs({
      fromCssW: 0,
      toCssW: 250,
      tileCssW: 100,
      extendPingPong: false,
    });
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ destX: 0, destW: 100, reverse: false });
    expect(segs[1]).toMatchObject({ destX: 100, destW: 100, reverse: false });
    expect(segs[2]).toMatchObject({ destX: 200, destW: 50, reverse: false });
  });
});

describe("prepareClipWaveformLayers", () => {
  it("scales vocals lower than mix on a shared amplitude scale", () => {
    const mix = {
      peaks: [1, 1, 1, 1],
      durationSec: 4,
      amplitudeMax: 1,
    };
    const vocals = {
      peaks: [1, 1, 1, 1],
      durationSec: 4,
      amplitudeMax: 0.25,
    };
    const layers = prepareClipWaveformLayers(mix, vocals, 0, 4, 4);
    expect(layers.overlay?.[0]).toBeCloseTo(0.25, 3);
    expect(layers.mix[0]).toBeCloseTo(1, 3);
  });

  it("reverses both layers when requested", () => {
    const mix = {
      peaks: [0.1, 0.9],
      durationSec: 2,
      amplitudeMax: 1,
    };
    const forward = prepareClipWaveformLayers(mix, null, 0, 2, 2, false);
    const reversed = prepareClipWaveformLayers(mix, null, 0, 2, 2, true);
    expect(reversed.mix[0]).toBeGreaterThan(reversed.mix[1]);
    expect(forward.mix[0]).toBeLessThan(forward.mix[1]);
  });
});
