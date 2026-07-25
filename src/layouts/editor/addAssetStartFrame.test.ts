import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  clipSongTimeRangeFromTimeline,
  firstFrameSourceSec,
  lastFrameSourceSec,
  nextVideoClipAfter,
  priorVideoClipBefore,
  resolveAddAssetGenerationTiming,
  resolveEditorMainAudioCreationId,
  timelineSecToSongSec,
  visualLayerAfterPlaceholder,
  visualLayerBeforePlaceholder,
} from "./addAssetStartFrame";
import { resolveTimelineFrame } from "./timelineCompose";

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

describe("resolveEditorMainAudioCreationId", () => {
  it("uses timeline audio when Lab main audio is unset", () => {
    const timeline = [
      clip({
        id: "a1",
        lane: "audio",
        kind: "audio",
        startSec: 0,
        endSec: 240,
        assetId: "timeline-audio",
      }),
    ];
    expect(resolveEditorMainAudioCreationId(timeline, null, null)).toBe(
      "timeline-audio",
    );
  });

  it("prefers the Lab main audio clip when it is on the timeline", () => {
    const timeline = [
      clip({
        id: "a1",
        lane: "audio",
        kind: "audio",
        startSec: 0,
        endSec: 10,
        assetId: "other-audio",
      }),
      clip({
        id: "a2",
        lane: "audio",
        kind: "audio",
        startSec: 10,
        endSec: 20,
        assetId: "lab-audio",
      }),
    ];
    expect(
      resolveEditorMainAudioCreationId(timeline, "lab-audio", "project-audio"),
    ).toBe("lab-audio");
  });

  it("falls back to Lab/project audio when the timeline has none", () => {
    expect(
      resolveEditorMainAudioCreationId([], "lab-audio", "project-audio"),
    ).toBe("lab-audio");
    expect(resolveEditorMainAudioCreationId([], null, "project-audio")).toBe(
      "project-audio",
    );
  });
});

describe("resolveAddAssetGenerationTiming", () => {
  it("clamps duration and keeps song range length matched", () => {
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
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 40,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    const timing = resolveAddAssetGenerationTiming(
      timeline,
      timeline[1]!,
      "mix",
    );
    expect(timing.durationSec).toBe(15);
    expect(timing.songRange.endSec - timing.songRange.startSec).toBeCloseTo(
      15,
      1,
    );
  });
});

describe("priorVideoClipBefore", () => {
  it("picks the immediately preceding clip, not an earlier one", () => {
    const timeline = [
      clip({ id: "early", startSec: 0, endSec: 3.2, assetId: "a" }),
      clip({ id: "mid", startSec: 3.2, endSec: 6.4, assetId: "b" }),
      clip({ id: "prior", startSec: 93.5, endSec: 101, assetId: "c" }),
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    expect(priorVideoClipBefore(timeline, 101, "placeholder")?.id).toBe("prior");
  });

  it("includes an image clip immediately before the placeholder", () => {
    const timeline = [
      clip({
        id: "still",
        startSec: 92,
        endSec: 101,
        assetId: "img-1",
        kind: "image",
      }),
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    expect(priorVideoClipBefore(timeline, 101, "placeholder")?.id).toBe("still");
  });
});

describe("nextVideoClipAfter", () => {
  it("picks the immediately following clip, not a later one", () => {
    const timeline = [
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({ id: "next", startSec: 19, endSec: 28, assetId: "n" }),
      clip({ id: "later", startSec: 40, endSec: 50, assetId: "l" }),
    ];
    expect(nextVideoClipAfter(timeline, 19, "placeholder")?.id).toBe("next");
  });

  it("ignores other placeholders", () => {
    const timeline = [
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({
        id: "other-ghost",
        startSec: 19,
        endSec: 28,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({ id: "real", startSec: 30, endSec: 40, assetId: "r" }),
    ];
    expect(nextVideoClipAfter(timeline, 19, "placeholder")?.id).toBe("real");
  });

  it("returns null when nothing follows", () => {
    const timeline = [
      clip({ id: "prior", startSec: 0, endSec: 10, assetId: "p" }),
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    expect(nextVideoClipAfter(timeline, 19, "placeholder")).toBeNull();
  });
});

describe("bridge neighbor availability", () => {
  it("has both neighbors when placeholder sits between filled clips", () => {
    const timeline = [
      clip({ id: "prior", startSec: 0, endSec: 10, assetId: "p" }),
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({ id: "next", startSec: 19, endSec: 28, assetId: "n" }),
    ];
    expect(priorVideoClipBefore(timeline, 10, "placeholder")?.id).toBe("prior");
    expect(nextVideoClipAfter(timeline, 19, "placeholder")?.id).toBe("next");
  });

  it("missing next means no bridge", () => {
    const timeline = [
      clip({ id: "prior", startSec: 0, endSec: 10, assetId: "p" }),
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    expect(priorVideoClipBefore(timeline, 10, "placeholder")?.id).toBe("prior");
    expect(nextVideoClipAfter(timeline, 19, "placeholder")).toBeNull();
  });

  it("missing prior means no bridge", () => {
    const timeline = [
      clip({
        id: "placeholder",
        startSec: 0,
        endSec: 9,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({ id: "next", startSec: 9, endSec: 18, assetId: "n" }),
    ];
    expect(priorVideoClipBefore(timeline, 0, "placeholder")).toBeNull();
    expect(nextVideoClipAfter(timeline, 9, "placeholder")?.id).toBe("next");
  });
});

describe("lastFrameSourceSec", () => {
  it("uses timeline duration when outSec extends past the visible clip", () => {
    const prior = clip({
      id: "v",
      startSec: 93.5,
      endSec: 101,
      inSec: 0,
      outSec: 10,
      kind: "video",
    });
    expect(lastFrameSourceSec(prior)).toBeCloseTo(7.45, 2);
  });

  it("uses timeline duration when outSec is shorter than the visible clip", () => {
    const prior = clip({
      id: "v",
      startSec: 93.4,
      endSec: 101,
      inSec: 0,
      outSec: 3.2,
      kind: "video",
    });
    expect(lastFrameSourceSec(prior)).toBeCloseTo(7.55, 2);
  });
});

describe("firstFrameSourceSec", () => {
  it("uses the clip in-point at timeline start", () => {
    const next = clip({
      id: "v",
      startSec: 20,
      endSec: 30,
      inSec: 2.5,
      outSec: 12.5,
      kind: "video",
    });
    expect(firstFrameSourceSec(next)).toBeCloseTo(2.5, 2);
  });
});

describe("visualLayerBeforePlaceholder", () => {
  it("resolves the clip visible at the cut, not an earlier one", () => {
    const timeline = [
      clip({ id: "early", startSec: 0, endSec: 3.2, assetId: "a" }),
      clip({ id: "prior", startSec: 93.4, endSec: 101, assetId: "b" }),
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    const layer = visualLayerBeforePlaceholder(timeline, timeline[2]!);
    expect(layer?.clip.id).toBe("prior");
    expect(layer?.sourceSec).toBeCloseTo(7.55, 2);
    expect(resolveTimelineFrame(timeline, 100.999).visual?.clip.id).toBe("prior");
  });

  it("resolves an image clip before the placeholder", () => {
    const timeline = [
      clip({
        id: "still",
        startSec: 92,
        endSec: 101,
        assetId: "img-1",
        kind: "image",
      }),
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    expect(visualLayerBeforePlaceholder(timeline, timeline[1]!)?.clip.id).toBe(
      "still",
    );
  });
});

describe("visualLayerAfterPlaceholder", () => {
  it("resolves the clip visible just after the placeholder ends", () => {
    const timeline = [
      clip({
        id: "placeholder",
        startSec: 10,
        endSec: 19,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
      clip({
        id: "next",
        startSec: 19,
        endSec: 28,
        assetId: "n",
        inSec: 1,
        outSec: 10,
      }),
    ];
    const layer = visualLayerAfterPlaceholder(timeline, timeline[0]!);
    expect(layer?.clip.id).toBe("next");
    expect(layer?.sourceSec).toBeCloseTo(1, 2);
  });
});

describe("clipSongTimeRangeFromTimeline", () => {
  it("keeps timeline seconds when aligned audio starts at zero", () => {
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
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    const range = clipSongTimeRangeFromTimeline(
      timeline,
      timeline[1]!,
      "mix",
    );
    expect(range.startSec).toBeCloseTo(101, 2);
    expect(range.endSec).toBeCloseTo(110, 2);
  });

  it("maps timeline seconds through offset audio", () => {
    const timeline = [
      clip({
        id: "audio",
        lane: "audio",
        kind: "audio",
        startSec: 5,
        endSec: 200,
        assetId: "mix",
        inSec: 0,
        outSec: 200,
      }),
      clip({
        id: "placeholder",
        startSec: 101,
        endSec: 110,
        isAddAssetPlaceholder: true,
        assetId: "",
      }),
    ];
    const range = clipSongTimeRangeFromTimeline(
      timeline,
      timeline[1]!,
      "mix",
    );
    expect(range.startSec).toBeCloseTo(96, 2);
    expect(range.endSec).toBeCloseTo(105, 2);
    expect(timelineSecToSongSec(timeline, 101, "mix")).toBeCloseTo(96, 2);
  });
});
