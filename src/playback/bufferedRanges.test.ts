import { describe, expect, it } from "vitest";
import {
  bufferedCoversSec,
  bufferedIsContinuous,
  formatBufferedRanges,
  nextBufferedSecAfter,
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

  it("jumps a one-fragment hole and refuses a long gap", () => {
    const ranges = [
      { start: 0, end: 19.98 },
      { start: 22, end: 24 },
    ];
    expect(bufferedCoversSec(ranges, 20.08)).toBe(false);
    expect(nextBufferedSecAfter(ranges, 20.08)).toBe(22);
    expect(nextBufferedSecAfter(ranges, 19.9)).toBe(null);
    expect(
      nextBufferedSecAfter(
        [
          { start: 0, end: 20 },
          { start: 28, end: 30 },
        ],
        20.08,
      ),
    ).toBe(null);
  });
});
