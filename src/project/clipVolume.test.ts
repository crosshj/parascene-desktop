import { describe, expect, it } from "vitest";
import {
  clipVolumeGain,
  clipVolumeIsUnity,
  clipVolumePercent,
  monitorElementVolume,
  persistClipVolume,
} from "./clipVolume";

describe("clipVolume", () => {
  it("treats omitted and 100 as unity", () => {
    expect(clipVolumePercent({})).toBe(100);
    expect(clipVolumePercent({ volume: 100 })).toBe(100);
    expect(clipVolumeGain({})).toBe(1);
    expect(clipVolumeIsUnity({})).toBe(true);
    expect(persistClipVolume({})).toBeUndefined();
    expect(persistClipVolume({ volume: 100 })).toBeUndefined();
  });

  it("clamps and persists non-unity values", () => {
    expect(clipVolumePercent({ volume: 40 })).toBe(40);
    expect(clipVolumeGain({ volume: 40 })).toBe(0.4);
    expect(persistClipVolume({ volume: 40 })).toBe(40);
    expect(clipVolumePercent({ volume: 0 })).toBe(0);
    expect(persistClipVolume({ volume: 0 })).toBe(0);
    expect(clipVolumePercent({ volume: -8 })).toBe(0);
    expect(clipVolumePercent({ volume: 140 })).toBe(100);
    expect(persistClipVolume({ volume: 140 })).toBeUndefined();
  });

  it("multiplies monitor master by instance gain", () => {
    expect(monitorElementVolume(80, { volume: 50 })).toBeCloseTo(0.4);
    expect(monitorElementVolume(100, {})).toBe(1);
    expect(monitorElementVolume(0, { volume: 80 })).toBe(0);
  });
});
