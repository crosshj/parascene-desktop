import { describe, expect, it } from "vitest";
import { nextAudioStartSec } from "./runAgentAudio";
import type { TimelineClip } from "../project/types";

function clip(
  partial: Partial<TimelineClip> & Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: "",
    assetId: partial.id,
    thumbUrl: null,
    lane: "audio",
    kind: "audio",
    inSec: 0,
    outSec: partial.endSec - partial.startSec,
    ...partial,
  };
}

describe("nextAudioStartSec", () => {
  it("starts at 0 on an empty track", () => {
    expect(nextAudioStartSec([], 1)).toBe(0);
    expect(nextAudioStartSec([], 2)).toBe(0);
  });

  it("appends after the last clip on that track", () => {
    const clips = [
      clip({ id: "a1", startSec: 0, endSec: 2.5 }),
      clip({ id: "a2", startSec: 0, endSec: 8, audioTrack: 2 }),
    ];
    expect(nextAudioStartSec(clips, 1)).toBe(2.5);
    expect(nextAudioStartSec(clips, 2)).toBe(8);
  });
});
