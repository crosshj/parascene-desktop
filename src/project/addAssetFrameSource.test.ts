import { describe, expect, it } from "vitest";
import {
  continuityFromFrameSources,
  durableFrameSourceFromPreview,
  frameSourceAssetId,
  frameSourceIsSet,
  parseAddAssetFrameSource,
  resolveFirstFrameSource,
  resolveLastFrameSource,
} from "./addAssetFrameSource";

describe("parseAddAssetFrameSource", () => {
  it("parses timeline, none, and asset sources", () => {
    expect(parseAddAssetFrameSource({ kind: "timeline" })).toEqual({
      kind: "timeline",
    });
    expect(parseAddAssetFrameSource({ kind: "none" })).toEqual({
      kind: "none",
    });
    expect(
      parseAddAssetFrameSource({ kind: "asset", assetId: " img-1 " }),
    ).toEqual({ kind: "asset", assetId: "img-1" });
  });

  it("rejects invalid rows", () => {
    expect(parseAddAssetFrameSource(null)).toBeUndefined();
    expect(parseAddAssetFrameSource({ kind: "asset" })).toBeUndefined();
    expect(parseAddAssetFrameSource({ kind: "other" })).toBeUndefined();
  });
});

describe("resolveFirstFrameSource", () => {
  it("prefers explicit firstFrameSource", () => {
    expect(
      resolveFirstFrameSource({
        firstFrameSource: { kind: "timeline" },
        startFrameAssetId: "img-legacy",
      }),
    ).toEqual({ kind: "timeline" });
  });

  it("migrates legacy startFrameAssetId to an asset source", () => {
    expect(
      resolveFirstFrameSource({
        startFrameAssetId: "img-1",
      }),
    ).toEqual({ kind: "asset", assetId: "img-1" });
  });

  it("returns undefined when neither is set", () => {
    expect(resolveFirstFrameSource({})).toBeUndefined();
  });
});

describe("resolveLastFrameSource", () => {
  it("migrates first_last continuity to timeline when last is unset", () => {
    expect(
      resolveLastFrameSource({ continuityMode: "first_last" }),
    ).toEqual({ kind: "timeline" });
  });

  it("defaults to none for start_frame", () => {
    expect(
      resolveLastFrameSource({ continuityMode: "start_frame" }),
    ).toEqual({ kind: "none" });
  });

  it("prefers explicit lastFrameSource", () => {
    expect(
      resolveLastFrameSource({
        lastFrameSource: { kind: "none" },
        continuityMode: "first_last",
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("continuityFromFrameSources", () => {
  it("derives start_frame, first_last, and none", () => {
    expect(
      continuityFromFrameSources({ kind: "timeline" }, { kind: "none" }),
    ).toBe("start_frame");
    expect(
      continuityFromFrameSources(
        { kind: "asset", assetId: "a" },
        { kind: "timeline" },
      ),
    ).toBe("first_last");
    expect(
      continuityFromFrameSources({ kind: "none" }, { kind: "none" }),
    ).toBe("none");
  });
});

describe("durableFrameSourceFromPreview", () => {
  it("promotes image asset ids only", () => {
    expect(
      durableFrameSourceFromPreview(
        { sourceAssetId: "img-1", sourceIsImage: true },
        { kind: "timeline" },
      ),
    ).toEqual({ kind: "asset", assetId: "img-1" });
    expect(
      durableFrameSourceFromPreview(
        { sourceAssetId: "vid-1", sourceIsImage: false },
        { kind: "timeline" },
      ),
    ).toEqual({ kind: "timeline" });
    expect(
      durableFrameSourceFromPreview(
        { sourceAssetId: "img-2", sourceIsImage: true },
        { kind: "asset", assetId: "keep" },
      ),
    ).toEqual({ kind: "asset", assetId: "keep" });
  });
});

describe("frameSourceAssetId / frameSourceIsSet", () => {
  it("returns the asset id only for asset sources", () => {
    expect(frameSourceAssetId({ kind: "timeline" })).toBeNull();
    expect(frameSourceAssetId({ kind: "none" })).toBeNull();
    expect(frameSourceAssetId({ kind: "asset", assetId: "a" })).toBe("a");
    expect(frameSourceIsSet({ kind: "none" })).toBe(false);
    expect(frameSourceIsSet({ kind: "timeline" })).toBe(true);
  });
});
