import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  clipSongTimeRangeFromTimeline,
  lastFrameSourceSec,
  priorVideoClipBefore,
  timelineSecToSongSec,
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
