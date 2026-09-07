import { describe, expect, it } from "vitest";
import {
  TimelineAssetInUseError,
  applyProjectAssetRemove,
  assertAssetsNotOnTimeline,
  classifyProjectAssetIds,
  collectTimelineUsedAssetIds,
} from "./projectAssetOps";

describe("collectTimelineUsedAssetIds", () => {
  it("collects clip, slideshow, and start-frame asset ids", () => {
    const used = collectTimelineUsedAssetIds([
      {
        assetId: "clip-1",
        slideshow: { imageAssetIds: ["still-a"], audioAssetId: "speech-1" },
        addAssetGeneration: {
          creationId: "gen-1",
          startFrameAssetId: "start-1",
          firstFrameSource: { kind: "asset", assetId: "first-1" },
          lastFrameSource: { kind: "timeline" },
        },
      },
    ]);
    expect([...used].sort()).toEqual(
      ["clip-1", "first-1", "gen-1", "speech-1", "start-1", "still-a"].sort(),
    );
  });
});

describe("assertAssetsNotOnTimeline", () => {
  it("throws when a selected id is on the timeline", () => {
    expect(() =>
      assertAssetsNotOnTimeline(["a", "b"], new Set(["b"])),
    ).toThrow(TimelineAssetInUseError);
  });

  it("passes when none of the ids are used", () => {
    expect(() =>
      assertAssetsNotOnTimeline(["a"], new Set(["b"])),
    ).not.toThrow();
  });
});

describe("classifyProjectAssetIds", () => {
  it("expands a cover id to every current member", () => {
    expect(
      classifyProjectAssetIds(["img-cover"], {
        imagesGroupId: "img-cover",
        videosGroupId: null,
        imagesMemberIds: ["18841", "18845"],
        videosMemberIds: [],
      }),
    ).toEqual({
      imagesMemberIds: ["18841", "18845"],
      videosMemberIds: [],
      standaloneIds: [],
    });
  });

  it("splits cabinet members from loose tiles", () => {
    expect(
      classifyProjectAssetIds(["18841", "local-9"], {
        imagesGroupId: "img-cover",
        videosGroupId: null,
        imagesMemberIds: ["18841"],
        videosMemberIds: [],
      }),
    ).toEqual({
      imagesMemberIds: ["18841"],
      videosMemberIds: [],
      standaloneIds: ["local-9"],
    });
  });
});

describe("applyProjectAssetRemove persist order", () => {
  it("persists empty cabinet pointers before native unfile", async () => {
    const order: string[] = [];
    const result = await applyProjectAssetRemove(
      {
        projectId: "p1",
        projectTitle: "Test",
        imagesGroupId: null,
        videosGroupId: null,
        timelineUsedIds: new Set(),
        persistOpenProjectAfterAssets: async ({ hideIds }) => {
          order.push("persist");
          expect(hideIds).toContain("still-1");
        },
        removeCreationsFromOpenProject: async () => {
          order.push("unfile");
        },
        addCreationsToOpenProject: async () => {
          order.push("add");
        },
        deleteLibraryCreation: async () => {
          order.push("delete");
        },
        setOpenProjectGroupIds: () => {
          order.push("set-pointer");
        },
      },
      ["still-1"],
    );
    expect(result.imagesGroupId).toBeNull();
    expect(order[0]).toBe("persist");
    expect(order).toContain("unfile");
    expect(order.indexOf("persist")).toBeLessThan(order.indexOf("unfile"));
    expect(order).not.toContain("set-pointer");
  });
});
