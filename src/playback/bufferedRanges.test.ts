import { describe, expect, it } from "vitest";
import {
  bufferedCoversRangeExact,
  bufferedCoversSec,
  bufferedIsContinuous,
  formatBufferedRanges,
} from "./bufferedRanges";

describe("buffered ranges", () => {
  it("formats one continuous range like [0.000, 8.000]", () => {
    expect(formatBufferedRanges([{ start: 0, end: 8 }])).toBe("[0.000, 8.000]");
  });

  it("flags a 20ms hole between sequential fragments as a gap", () => {
    const ranges = [
      { start: 0, end: 1.98 },
      { start: 2, end: 3.98 },
    ];
    expect(formatBufferedRanges(ranges)).toBe("[0.000, 1.980] [2.000, 3.980]");
    expect(bufferedIsContinuous(ranges)).toBe(false);
  });

  it("treats a single range as continuous", () => {
    expect(bufferedIsContinuous([{ start: 0, end: 8 }])).toBe(true);
    expect(bufferedIsContinuous([])).toBe(true);
  });

  it("requires exact range coverage for admission", () => {
    const ranges = [{ start: 0, end: 1.98 }];
    expect(bufferedCoversRangeExact(ranges, 0, 2)).toBe(false);
    expect(bufferedCoversRangeExact(ranges, 0, 1.98)).toBe(true);
    expect(bufferedCoversSec(ranges, 0.01)).toBe(true);
  });
});
