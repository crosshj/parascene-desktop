import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  dirtyFragmentIndices,
  fragmentIndexAtSec,
  fragmentJobPriority,
  fragmentPlaybackHasContinuity,
  FRAGMENT_DURATION_SEC,
  planTimelineFragments,
} from "./timelineFragmentPlan";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    ...partial,
  };
}

describe("planTimelineFragments", () => {
  it("splits a sequence into 2s fragments with a short tail", () => {
    const plan = planTimelineFragments(
      [clip({ id: "a", startSec: 0, endSec: 5.5, assetId: "v1" })],
      "16:9",
      5.5,
    );
    expect(plan.fragmentCount).toBe(3);
    expect(plan.fragments.map((f) => f.durationSec)).toEqual([
      FRAGMENT_DURATION_SEC,
      FRAGMENT_DURATION_SEC,
      1.5,
    ]);
    expect(plan.fragments[2].startSec).toBe(4);
  });

  it("fingerprints only overlapping visual clips, including a 1-frame neighbor pad", () => {
    const clips = [
      clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
      clip({ id: "b", startSec: 2, endSec: 4, assetId: "v2" }),
      clip({
        id: "bed",
        startSec: 0,
        endSec: 8,
        lane: "audio",
        kind: "audio",
        assetId: "a1",
      }),
    ];
    const plan = planTimelineFragments(clips, "16:9", 4);
    expect(plan.fragments[0].clipIds).toEqual(["a", "b"]);
    expect(plan.fragments[1].clipIds).toEqual(["a", "b"]);
  });

  it("invalidates only fragments whose contributing clips changed", () => {
    const first = planTimelineFragments(
      [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v2" }),
      ],
      "16:9",
      6,
    );
    const moved = planTimelineFragments(
      [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v3" }),
      ],
      "16:9",
      6,
    );
    expect(dirtyFragmentIndices(first, moved)).toEqual([2]);
  });

  it("changes every fingerprint when aspect ratio changes", () => {
    const clips = [clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" })];
    const wide = planTimelineFragments(clips, "16:9", 2);
    const tall = planTimelineFragments(clips, "9:16", 2);
    expect(wide.fragments[0].fingerprint).not.toBe(
      tall.fragments[0].fingerprint,
    );
  });

  it("keeps stable timestamps so an edit far away does not dirty earlier fragments", () => {
    const short = planTimelineFragments(
      [clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" })],
      "16:9",
      2,
    );
    const longer = planTimelineFragments(
      [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 8, endSec: 10, assetId: "v2" }),
      ],
      "16:9",
      10,
    );
    expect(longer.fragments[0].startSec).toBe(0);
    expect(longer.fragments[0].fingerprint).toBe(short.fragments[0].fingerprint);
    expect(dirtyFragmentIndices(short, longer)).toEqual([1, 2, 3, 4]);
  });

  it("ranks jobs by playhead: current, next, previous, then distance", () => {
    expect(fragmentJobPriority(3, 3)).toBe(0);
    expect(fragmentJobPriority(4, 3)).toBe(1);
    expect(fragmentJobPriority(2, 3)).toBe(2);
    expect(fragmentJobPriority(7, 3)).toBeGreaterThan(fragmentJobPriority(5, 3));
  });

  it("maps playhead time onto a fragment index", () => {
    expect(fragmentIndexAtSec(0, 90)).toBe(0);
    expect(fragmentIndexAtSec(1.99, 90)).toBe(0);
    expect(fragmentIndexAtSec(2, 90)).toBe(1);
    expect(fragmentIndexAtSec(8, 12 * 30)).toBe(4);
  });

  it("drops MSE continuity near a fragment end unless the next chunk is ready", () => {
    const covering = { startSec: 0, durationSec: 2 };
    expect(
      fragmentPlaybackHasContinuity({
        sec: 1.5,
        sequenceEndSec: 10,
        covering,
        nextReady: false,
      }),
    ).toBe(true);
    expect(
      fragmentPlaybackHasContinuity({
        sec: 1.9,
        sequenceEndSec: 10,
        covering,
        nextReady: false,
      }),
    ).toBe(false);
    expect(
      fragmentPlaybackHasContinuity({
        sec: 1.9,
        sequenceEndSec: 10,
        covering,
        nextReady: true,
      }),
    ).toBe(true);
    expect(
      fragmentPlaybackHasContinuity({
        sec: 1.9,
        sequenceEndSec: 2,
        covering,
        nextReady: false,
      }),
    ).toBe(true);
  });
});
