import { describe, expect, it } from "vitest";
import { detectVocalBlocks } from "./vocalBlocks";

describe("detectVocalBlocks", () => {
  const durationSec = 100;

  it("splits two vocal regions at a silent gap", () => {
    const peaks = Array.from({ length: 100 }, (_, i) => {
      if (i < 30) return 0.9;
      if (i < 70) return 0.01;
      return 0.85;
    });
    const blocks = detectVocalBlocks(peaks, durationSec);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].startSec).toBeCloseTo(0, 0);
    expect(blocks[0].endSec).toBeLessThan(35);
    expect(blocks[1].startSec).toBeGreaterThan(65);
  });

  it("drops a trailing silent tail from the last block", () => {
    const peaks = Array.from({ length: 100 }, (_, i) => (i < 50 ? 0.9 : 0.01));
    const blocks = detectVocalBlocks(peaks, durationSec);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].endSec).toBeLessThan(55);
  });
});
