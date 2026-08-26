import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  clipSourceSec,
  clipSourceSpanSec,
  clipIsTimelineExtended,
  clipExtendDivitFraction,
  clipExtendSourceSpanSec,
  clipPlaythroughUnitSec,
  finalizeVideoResizeEndSec,
  peekNextVisualClip,
  peekPrevVisualClip,
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

  it("maps source through speed without moving clip ends", () => {
    const c = clip({
      id: "v",
      startSec: 0,
      endSec: 5,
      inSec: 0,
      outSec: 4,
      kind: "video",
      speed: 2,
    });
    // Playthrough = 4/2 = 2s; timeline 5s stays put → extended.
    expect(clipSourceSec(c, 1)).toBe(2);
    expect(clipSourceSec(c, 2.5)).toBe(1);
    expect(clipIsTimelineExtended(c)).toBe(true);
    expect(clipExtendDivitFraction(c)).toBeCloseTo(2 / 5);
    expect(c.startSec).toBe(0);
    expect(c.endSec).toBe(5);
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

  it("loops Include Audio companions like their parent video", () => {
    const companion = clip({
      id: "a-link",
      startSec: 0,
      endSec: 8,
      inSec: 0,
      outSec: 5,
      kind: "audio",
      lane: "audio",
      linkedVideoClipId: "v",
    });
    expect(clipIsTimelineExtended(companion)).toBe(true);
    expect(clipSourceSec(companion, 6)).toBe(1);
    const bed = clip({
      id: "a-bed",
      startSec: 0,
      endSec: 8,
      inSec: 0,
      outSec: 5,
      kind: "audio",
      lane: "audio",
    });
    expect(clipIsTimelineExtended(bed)).toBe(false);
    expect(clipSourceSec(bed, 6)).toBe(5);
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

  it("clamps a stale frozen extend span down to the live trim", () => {
    // in raised after span was frozen at outSec — playthrough must follow trim.
    const c = clip({
      id: "v",
      startSec: 9,
      endSec: 27.1,
      inSec: 2.328,
      outSec: 8.881,
      kind: "video",
      extendPingPong: true,
      extendSourceSpanSec: 8.881,
    });
    const trim = 8.881 - 2.328;
    expect(clipExtendSourceSpanSec(c)).toBeCloseTo(trim, 3);
    expect(clipPlaythroughUnitSec(c)).toBeCloseTo(trim, 3);
    // Second tile starts a pong (reverse) from out — no silent jump past the trim.
    expect(clipSourceSec(c, 9 + trim + 0.01)).toBeCloseTo(8.881 - 0.01, 2);
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

  it("skips hairline clips so playback never seek+plays a sliver cut", () => {
    const clips = [
      clip({
        id: "a",
        startSec: 0,
        endSec: 5.7,
        assetId: "goblin",
        kind: "video",
        lane: "video",
      }),
      clip({
        id: "sliver",
        startSec: 5.7,
        endSec: 5.74,
        assetId: "crumb",
        kind: "video",
        lane: "video",
      }),
      clip({
        id: "b",
        startSec: 5.74,
        endSec: 11.54,
        assetId: "suit",
        kind: "video",
        lane: "video",
      }),
    ];
    expect(resolveTimelineFrame(clips, 5.71).visual?.clip.id).toBe("b");
    expect(peekNextVisualClip(clips, 5.0)?.id).toBe("b");
    expect(peekPrevVisualClip(clips, 8)?.id).toBe("a");
  });

  it("ranks linked video-audio above bed audio for the monitor mix", () => {
    const frame = resolveTimelineFrame(
      [
        clip({
          id: "bed",
          startSec: 0,
          endSec: 20,
          lane: "audio",
          kind: "audio",
          assetId: "song",
        }),
        clip({
          id: "linked",
          startSec: 2,
          endSec: 8,
          lane: "audio",
          kind: "audio",
          assetId: "take",
          linkedVideoClipId: "vid",
        }),
      ],
      4,
    );
    expect(frame.audio.map((l) => l.clip.id)).toEqual(["linked", "bed"]);
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

describe("peekPrevVisualClip", () => {
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

  it("returns the clip that ended when the current one starts", () => {
    expect(peekPrevVisualClip(clips, 3)).toBeNull();
    expect(peekPrevVisualClip(clips, 10)?.id).toBe("a");
    expect(peekPrevVisualClip(clips, 35)?.id).toBe("b");
  });

  it("returns the clip before a gap", () => {
    expect(peekPrevVisualClip(clips, 25)?.id).toBe("b");
  });
});

describe("finalizeVideoResizeEndSec", () => {
  it("keeps an exact source-length collapse when 0.1s end snap would re-extend", () => {
    // startSec with subframe precision (e.g. 44:14 @ 30fps) + source 6.5s
    // rounds end upward on a 0.1s grid and would re-enter extend.
    const startSec = 44 + 14 / 30;
    const sourceSpanSec = 6.5;
    const pointerEndSec = startSec + sourceSpanSec;
    const snappedEndSec = Math.round(pointerEndSec * 10) / 10;
    expect(snappedEndSec - startSec).toBeGreaterThan(sourceSpanSec + 0.001);

    const endSec = finalizeVideoResizeEndSec({
      startSec,
      pointerEndSec,
      snappedEndSec,
      sourceSpanSec,
    });
    expect(endSec).toBeCloseTo(startSec + sourceSpanSec, 6);
    expect(endSec - startSec).toBeLessThanOrEqual(sourceSpanSec + 0.001);
  });

  it("preserves snapped length when the user intentionally extended", () => {
    const startSec = 10;
    const sourceSpanSec = 6.5;
    const pointerEndSec = startSec + 8.2;
    const snappedEndSec = startSec + 8.0;
    expect(
      finalizeVideoResizeEndSec({
        startSec,
        pointerEndSec,
        snappedEndSec,
        sourceSpanSec,
      }),
    ).toBe(snappedEndSec);
  });
});
