import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  clipSourceSec,
  clipSourceSpanSec,
  clipIsTimelineExtended,
  clipExtendDivitFraction,
  peekNextVisualClip,
  resolveTimelineFrame,
  timelineSequenceDuration,
} from "./timelineCompose";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "image",
    ...partial,
  };
}

describe("timelineSequenceDuration", () => {
  it("returns 0 for an empty timeline", () => {
    expect(timelineSequenceDuration([])).toBe(0);
  });

  it("returns the max endSec across lanes", () => {
    expect(
      timelineSequenceDuration([
        clip({ id: "v1", startSec: 0, endSec: 30, lane: "video" }),
        clip({ id: "a1", startSec: 0, endSec: 161.4, lane: "audio" }),
      ]),
    ).toBe(161.4);
  });
});

describe("clipSourceSec", () => {
  it("maps timeline time into source in/out", () => {
    const c = clip({
      id: "v",
      startSec: 10,
      endSec: 20,
      inSec: 2,
      outSec: 12,
      kind: "video",
    });
    expect(clipSourceSec(c, 10)).toBe(2);
    expect(clipSourceSec(c, 15)).toBe(7);
    expect(clipSourceSec(c, 20)).toBe(12);
  });

  it("defaults in/out from timeline span for images", () => {
    const c = clip({ id: "img", startSec: 0, endSec: 30, kind: "image" });
    expect(clipSourceSec(c, 12)).toBe(12);
  });

  it("loops extended video past the source trim", () => {
    const c = clip({
      id: "v",
      startSec: 0,
      endSec: 8,
      inSec: 0,
      outSec: 5,
      kind: "video",
    });
    expect(clipSourceSpanSec(c)).toBe(5);
    expect(clipSourceSec(c, 6)).toBe(1);
    expect(clipSourceSec(c, 7)).toBe(2);
  });

  it("ping-pongs extended video past the source trim", () => {
    const c = clip({
      id: "v",
      startSec: 0,
      endSec: 10,
      inSec: 0,
      outSec: 4,
      kind: "video",
      extendPingPong: true,
    });
    expect(clipSourceSec(c, 4)).toBe(4);
    expect(clipSourceSec(c, 4.5)).toBeCloseTo(3.5);
    expect(clipSourceSec(c, 8)).toBeCloseTo(0);
    expect(clipSourceSec(c, 8.5)).toBeCloseTo(0.5);
    expect(clipSourceSec(c, 12)).toBeCloseTo(4);
    expect(clipSourceSec(c, 12.5)).toBeCloseTo(3.5);
  });

  it("detects timeline extend and divit position", () => {
    const c = clip({
      id: "v",
      startSec: 0,
      endSec: 9.5,
      inSec: 0,
      outSec: 9,
      kind: "video",
    });
    expect(clipIsTimelineExtended(c)).toBe(true);
    expect(clipExtendDivitFraction(c)).toBeCloseTo(9 / 9.5);
    const flat = clip({
      id: "v2",
      startSec: 0,
      endSec: 9,
      inSec: 0,
      outSec: 9,
      kind: "video",
    });
    expect(clipIsTimelineExtended(flat)).toBe(false);

    const frozen = clip({
      id: "v3",
      startSec: 0,
      endSec: 10,
      inSec: 0,
      outSec: 10,
      kind: "video",
      extendSourceSpanSec: 9,
    });
    expect(clipIsTimelineExtended(frozen)).toBe(true);
    expect(clipExtendDivitFraction(frozen)).toBeCloseTo(0.9);
  });
});

describe("resolveTimelineFrame", () => {
  const clips: TimelineClip[] = [
    clip({
      id: "img1",
      startSec: 0,
      endSec: 30,
      assetId: "a-forest",
      kind: "image",
      lane: "video",
    }),
    clip({
      id: "img2",
      startSec: 30,
      endSec: 60,
      assetId: "a-magic",
      kind: "image",
      lane: "video",
    }),
    clip({
      id: "gap-next",
      startSec: 70,
      endSec: 100,
      assetId: "a-later",
      kind: "image",
      lane: "video",
    }),
    clip({
      id: "music",
      startSec: 0,
      endSec: 161.4,
      assetId: "a-song",
      kind: "audio",
      lane: "audio",
      inSec: 0,
      outSec: 161.4,
    }),
  ];

  it("resolves the image under the playhead and the music bed", () => {
    const frame = resolveTimelineFrame(clips, 54);
    expect(frame.visual?.clip.id).toBe("img2");
    expect(frame.visual?.localSec).toBe(24);
    expect(frame.visual?.clip.assetId).toBe("a-magic");
    expect(frame.audio).toHaveLength(1);
    expect(frame.audio[0]?.clip.id).toBe("music");
    expect(frame.audio[0]?.sourceSec).toBe(54);
  });

  it("returns null visual in a gap while audio continues", () => {
    const frame = resolveTimelineFrame(clips, 65);
    expect(frame.visual).toBeNull();
    expect(frame.audio[0]?.clip.id).toBe("music");
  });

  it("holds the final visual frame at sequence end", () => {
    const short = [
      clip({ id: "last", startSec: 0, endSec: 11.5, assetId: "x", kind: "image" }),
    ];
    const frame = resolveTimelineFrame(short, 11.5);
    expect(frame.visual?.clip.id).toBe("last");
  });

  it("leaves room for video clips via kind on the layer", () => {
    const withVideo = [
      clip({
        id: "vid",
        startSec: 0,
        endSec: 8,
        assetId: "v1",
        kind: "video",
        inSec: 1,
        outSec: 9,
      }),
    ];
    const frame = resolveTimelineFrame(withVideo, 3);
    expect(frame.visual?.clip.kind).toBe("video");
    expect(frame.visual?.sourceSec).toBe(4);
  });
});

describe("peekNextVisualClip", () => {
  const clips: TimelineClip[] = [
    clip({ id: "a", startSec: 0, endSec: 10, assetId: "1", kind: "video" }),
    clip({ id: "b", startSec: 10, endSec: 20, assetId: "2", kind: "video" }),
    clip({ id: "c", startSec: 30, endSec: 40, assetId: "3", kind: "video" }),
    clip({
      id: "music",
      startSec: 0,
      endSec: 50,
      lane: "audio",
      kind: "audio",
      assetId: "m",
    }),
  ];

  it("returns the clip that starts when the current one ends", () => {
    expect(peekNextVisualClip(clips, 3)?.id).toBe("b");
    expect(peekNextVisualClip(clips, 10)?.id).toBe("c");
  });

  it("returns the next clip after a gap", () => {
    expect(peekNextVisualClip(clips, 25)?.id).toBe("c");
  });

  it("returns null when nothing follows", () => {
    expect(peekNextVisualClip(clips, 35)).toBeNull();
  });
});
