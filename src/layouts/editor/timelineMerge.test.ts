import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  MERGE_CONTIGUITY_EPSILON_SEC,
  getMergeableTimelineSelection,
} from "./timelineMerge";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    assetId: partial.assetId ?? partial.id,
    ...partial,
  };
}

describe("getMergeableTimelineSelection", () => {
  it("returns ordered contiguous selected video clips", () => {
    const timeline = [
      clip({ id: "b", startSec: 3, endSec: 6 }),
      clip({ id: "a", startSec: 0, endSec: 3 }),
      clip({ id: "music", startSec: 0, endSec: 6, lane: "audio", kind: "audio" }),
    ];
    const result = getMergeableTimelineSelection(timeline, ["b", "a"]);
    expect(result?.clips.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result?.startSec).toBe(0);
    expect(result?.endSec).toBe(6);
  });

  it("rejects non-contiguous selections", () => {
    const timeline = [
      clip({ id: "a", startSec: 0, endSec: 3 }),
      clip({ id: "b", startSec: 3 + MERGE_CONTIGUITY_EPSILON_SEC + 0.01, endSec: 6 }),
    ];
    expect(getMergeableTimelineSelection(timeline, ["a", "b"])).toBeNull();
  });

  it("rejects selections with non-video lanes or kinds", () => {
    const timeline = [
      clip({ id: "a", startSec: 0, endSec: 3 }),
      clip({ id: "b", startSec: 3, endSec: 6, kind: "image" }),
      clip({ id: "c", startSec: 6, endSec: 9, lane: "audio", kind: "audio" }),
    ];
    expect(getMergeableTimelineSelection(timeline, ["a", "b"])).toBeNull();
    expect(getMergeableTimelineSelection(timeline, ["a", "c"])).toBeNull();
  });

  it("requires at least two selected clips", () => {
    const timeline = [clip({ id: "a", startSec: 0, endSec: 3 })];
    expect(getMergeableTimelineSelection(timeline, ["a"])).toBeNull();
  });
});
