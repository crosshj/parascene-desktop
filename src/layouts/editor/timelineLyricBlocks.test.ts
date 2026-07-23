import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  songSecToTimelineSec,
  timelineLyricBlocks,
} from "./timelineLyricBlocks";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    assetId: partial.assetId ?? "asset-1",
    ...partial,
  };
}

describe("songSecToTimelineSec", () => {
  it("maps through a trimmed audio clip on the timeline", () => {
    const audio = clip({
      id: "audio",
      lane: "audio",
      kind: "audio",
      startSec: 5,
      endSec: 200,
      assetId: "mix",
      inSec: 0,
      outSec: 200,
    });
    expect(songSecToTimelineSec(audio, 96)).toBeCloseTo(101, 2);
  });
});

describe("timelineLyricBlocks", () => {
  it("places aligned lyric lines on the editor timeline", () => {
    const timeline = [
      clip({
        id: "audio",
        lane: "audio",
        kind: "audio",
        startSec: 0,
        endSec: 200,
        assetId: "mix",
        inSec: 0,
        outSec: 200,
      }),
    ];
    const alignment = {
      sourceAudioCreationId: "mix",
      lyricsText: "Hello",
      alignedAt: "now",
      transcribeEngine: "openai" as const,
      lines: [
        { line: "[Verse]", startSec: 0, endSec: 1, inaudible: true },
        { line: "Hello world", startSec: 10, endSec: 14 },
      ],
    };
    expect(
      timelineLyricBlocks(timeline, alignment, "mix"),
    ).toEqual([{ line: "Hello world", startSec: 10, endSec: 14 }]);
  });
});
