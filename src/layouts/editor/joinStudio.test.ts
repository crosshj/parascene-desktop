import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  defaultJoinStudioParams,
  getJoinableTimelinePair,
  joinEncodedDurationSec,
  JOIN_FPS,
  JOIN_MAX_GAP_SEC,
} from "./joinStudio";

function clip(
  partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    assetId: partial.assetId ?? partial.id,
    inSec: partial.inSec,
    outSec: partial.outSec,
    ...partial,
  };
}

describe("getJoinableTimelinePair", () => {
  it("returns ordered pair for abutting videos", () => {
    const timeline = [
      clip({ id: "b", startSec: 3, endSec: 6, inSec: 0, outSec: 3 }),
      clip({ id: "a", startSec: 0, endSec: 3, inSec: 0, outSec: 3 }),
    ];
    const pair = getJoinableTimelinePair(timeline, ["b", "a"]);
    expect(pair?.clipA.id).toBe("a");
    expect(pair?.clipB.id).toBe("b");
    expect(pair?.gapSec).toBe(0);
  });

  it("allows a gap up to JOIN_MAX_GAP_SEC", () => {
    const timeline = [
      clip({ id: "a", startSec: 0, endSec: 3 }),
      clip({ id: "b", startSec: 3 + 0.5, endSec: 6 }),
    ];
    const pair = getJoinableTimelinePair(timeline, ["a", "b"]);
    expect(pair?.gapSec).toBeCloseTo(0.5);
  });

  it("rejects gaps larger than JOIN_MAX_GAP_SEC", () => {
    const timeline = [
      clip({ id: "a", startSec: 0, endSec: 3 }),
      clip({ id: "b", startSec: 3 + JOIN_MAX_GAP_SEC + 0.01, endSec: 6 }),
    ];
    expect(getJoinableTimelinePair(timeline, ["a", "b"])).toBeNull();
  });

  it("rejects overlap and non-exact two selection", () => {
    const timeline = [
      clip({ id: "a", startSec: 0, endSec: 4 }),
      clip({ id: "b", startSec: 3, endSec: 6 }),
      clip({ id: "c", startSec: 6, endSec: 9 }),
    ];
    expect(getJoinableTimelinePair(timeline, ["a", "b"])).toBeNull();
    expect(getJoinableTimelinePair(timeline, ["a", "b", "c"])).toBeNull();
  });
});

describe("joinEncodedDurationSec", () => {
  it("sums trims for hard cut and subtracts xfade overlap", () => {
    const pair = getJoinableTimelinePair(
      [
        clip({ id: "a", startSec: 0, endSec: 2, inSec: 0, outSec: 2 }),
        clip({ id: "b", startSec: 2, endSec: 5, inSec: 0, outSec: 3 }),
      ],
      ["a", "b"],
    )!;
    const hard = defaultJoinStudioParams(0);
    expect(joinEncodedDurationSec(pair, hard)).toBeCloseTo(5);

    const xfade = { ...hard, strategy: "crossfade" as const, xfadeFrames: JOIN_FPS };
    expect(joinEncodedDurationSec(pair, xfade)).toBeCloseTo(4);

    const hold = { ...hard, strategy: "hold" as const, holdFrames: 6 };
    expect(joinEncodedDurationSec(pair, hold)).toBeCloseTo(5.2);
  });
});
