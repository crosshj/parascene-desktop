import { describe, expect, it } from "vitest";
import {
  collectRenderAssetIds,
  type RenderTimelineClipInput,
} from "./renderClient";

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
