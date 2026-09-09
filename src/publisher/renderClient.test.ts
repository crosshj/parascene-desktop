import { describe, expect, it } from "vitest";
import {
  collectRenderAssetIds,
  timelineClipsToRenderInput,
  type RenderTimelineClipInput,
} from "./renderClient";
import type { TimelineClip } from "../project/types";

describe("collectRenderAssetIds", () => {
  it("collects clip, slideshow, and audio asset ids", () => {
    const clips: RenderTimelineClipInput[] = [
      {
        assetId: "19512",
        startSec: 0,
        endSec: 5,
        kind: "video",
      },
      {
        startSec: 5,
        endSec: 15,
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["10", "11", "10"],
          mode: "even",
          audioAssetId: "99",
        },
      },
      {
        assetId: "  ",
        startSec: 0,
        endSec: 10,
        kind: "audio",
      },
    ];
    expect(collectRenderAssetIds(clips)).toEqual(["19512", "10", "11", "99"]);
  });
});

describe("timelineClipsToRenderInput", () => {
  it("passes A2 audioTrack through", () => {
    const clips: TimelineClip[] = [
      {
        id: "a2",
        label: "line",
        startSec: 0,
        endSec: 4,
        lane: "audio",
        kind: "audio",
        assetId: "speech",
        audioTrack: 2,
      },
    ];
    expect(timelineClipsToRenderInput(clips)[0]?.audioTrack).toBe(2);
  });

  it("passes non-unity clip volume through", () => {
    const clips: TimelineClip[] = [
      {
        id: "a1",
        label: "bed",
        startSec: 0,
        endSec: 8,
        lane: "audio",
        kind: "audio",
        assetId: "song",
        volume: 40,
      },
    ];
    expect(timelineClipsToRenderInput(clips)[0]?.volume).toBe(40);
  });
});
