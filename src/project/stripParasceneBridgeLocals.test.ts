import { describe, expect, it } from "vitest";
import type { StoredProject } from "./projectStore";
import type { TimelineClip } from "./types";
import {
  bridgeLocalIdsFromCreationTitles,
  isParasceneBridgeExtractTitle,
  stripParasceneBridgeLocals,
} from "./stripParasceneBridgeLocals";

function project(partial: Partial<StoredProject>): StoredProject {
  return {
    id: "p1",
    title: "Demo",
    creationIds: [],
    ...partial,
  } as StoredProject;
}

function clip(
  assetId: string,
  gen: NonNullable<TimelineClip["addAssetGeneration"]>,
): TimelineClip {
  return {
    id: `c-${assetId}`,
    label: assetId,
    assetId,
    kind: "video",
    startSec: 0,
    endSec: 9,
    addAssetGeneration: gen,
  };
}

describe("isParasceneBridgeExtractTitle", () => {
  it("matches framed extract filenames", () => {
    expect(
      isParasceneBridgeExtractTitle("25762-r-19-fit-404x720-z1000-x0-y0"),
    ).toBe(true);
    expect(
      isParasceneBridgeExtractTitle("25793-f-8999-fit-404x720-z1000-x0-y0"),
    ).toBe(true);
    expect(isParasceneBridgeExtractTitle("Untitled")).toBe(false);
    expect(isParasceneBridgeExtractTitle("26_25757_x.png")).toBe(false);
  });
});

describe("stripParasceneBridgeLocals", () => {
  it("removes Parascene-stamped local-* extracts and clears Form stamps", () => {
    const before = project({
      creationIds: ["local-bridge", "25757", "25762"],
      timeline: [
        clip("25762", {
          prompt: "x",
          generatedAt: "2026-08-23T00:00:00.000Z",
          creationId: "25762",
          mode: "start_frame",
          server: "parascene_blue",
          startFrameAssetId: "local-bridge",
          firstFrameSource: { kind: "asset", assetId: "local-bridge" },
          startFramePreviewUrl: "https://sh.parascene.com/api/share/v1/x/image",
        }),
      ],
    });
    const { project: next, removedIds } = stripParasceneBridgeLocals(before);
    expect(removedIds).toEqual(["local-bridge"]);
    expect(next.creationIds).toEqual(["25757", "25762"]);
    expect(next.timeline?.[0].addAssetGeneration?.startFrameAssetId).toBeUndefined();
    expect(next.timeline?.[0].addAssetGeneration?.firstFrameSource).toEqual({
      kind: "none",
    });
    expect(next.timeline?.[0].addAssetGeneration?.startFramePreviewUrl).toBe(
      "https://sh.parascene.com/api/share/v1/x/image",
    );
  });

  it("does not strip Blue Direct local stills", () => {
    const before = project({
      creationIds: ["local-durable", "vid-1"],
      timeline: [
        clip("vid-1", {
          prompt: "x",
          generatedAt: "2026-08-23T00:00:00.000Z",
          creationId: "vid-1",
          mode: "start_frame",
          server: "blue_direct",
          startFrameAssetId: "local-durable",
          firstFrameSource: { kind: "asset", assetId: "local-durable" },
        }),
      ],
    });
    const { project: next, removedIds } = stripParasceneBridgeLocals(before);
    expect(removedIds).toEqual([]);
    expect(next.creationIds).toEqual(["local-durable", "vid-1"]);
  });

  it("accepts catalog title extras for leftover fit extracts", () => {
    const before = project({
      creationIds: ["local-fit", "25764"],
      timeline: [],
    });
    const extras = bridgeLocalIdsFromCreationTitles([
      { id: "local-fit", title: "25762-r-19-fit-404x720-z1000-x0-y0" },
      { id: "25764", title: "26_25764.png" },
    ]);
    const { removedIds } = stripParasceneBridgeLocals(before, extras);
    expect(removedIds).toEqual(["local-fit"]);
  });
});
