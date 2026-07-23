import { describe, expect, it } from "vitest";
import {
  peaksForClipWindow,
  prepareClipWaveformLayers,
} from "./waveformPeakDraw";

describe("peaksForClipWindow", () => {
  it("samples the requested source-time range", () => {
    const peaks = [0, 0.25, 0.5, 0.75, 1];
    const window = peaksForClipWindow(peaks, 10, 2, 8, 4);
    expect(window).toHaveLength(4);
    expect(window[0]).toBeLessThan(window[3]);
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
