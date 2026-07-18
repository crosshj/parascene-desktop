import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import { findOverlappingAudioClip, overlapDurationSec } from "./audioOverlap";

function clip(
  partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.id,
    lane: "audio",
    kind: "audio",
    ...partial,
  };
}

describe("audioOverlap", () => {
  it("computes half-open overlap duration", () => {
    expect(
      overlapDurationSec(
        { startSec: 0, endSec: 10 },
        { startSec: 8, endSec: 12 },
      ),
    ).toBe(2);
    expect(
      overlapDurationSec(
        { startSec: 0, endSec: 5 },
        { startSec: 5, endSec: 10 },
      ),
    ).toBe(0);
  });

  it("picks the greatest overlapping audio clip", () => {
    const clips = [
      clip({ id: "a", startSec: 0, endSec: 4, assetId: "audio-a" }),
      clip({ id: "b", startSec: 3, endSec: 20, assetId: "audio-b" }),
      clip({
        id: "v",
        startSec: 2,
        endSec: 12,
        lane: "video",
        kind: "slideshow",
      }),
    ];
    const hit = findOverlappingAudioClip(clips, { startSec: 2, endSec: 12 });
    expect(hit?.id).toBe("b");
  });

  it("returns null when no audio overlaps", () => {
    const clips = [
      clip({ id: "a", startSec: 20, endSec: 30, assetId: "audio-a" }),
    ];
    expect(
      findOverlappingAudioClip(clips, { startSec: 0, endSec: 10 }),
    ).toBeNull();
  });
});
