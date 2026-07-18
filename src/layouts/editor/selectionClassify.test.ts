import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import {
  classifyAssetSelection,
  unsupportedSelectionMessage,
} from "./selectionClassify";

function creation(id: string, mediaType: string): Creation {
  return {
    id,
    title: id,
    mediaType,
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "",
    downloadState: "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "",
    filename: null,
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
  };
}

describe("classifyAssetSelection", () => {
  it("classifies a single asset", () => {
    const map = new Map([["a", creation("a", "video")]]);
    expect(classifyAssetSelection(["a"], map)).toEqual({
      type: "single",
      assetId: "a",
      kind: "video",
    });
  });

  it("stages multiple images as a composite", () => {
    const map = new Map([
      ["i1", creation("i1", "image")],
      ["i2", creation("i2", "image")],
    ]);
    expect(classifyAssetSelection(["i1", "i2"], map)).toEqual({
      type: "compositeImages",
      imageAssetIds: ["i1", "i2"],
    });
  });

  it("rejects multiple videos", () => {
    const map = new Map([
      ["v1", creation("v1", "video")],
      ["v2", creation("v2", "video")],
    ]);
    const result = classifyAssetSelection(["v1", "v2"], map);
    expect(result).toEqual({
      type: "unsupportedVideos",
      videoAssetIds: ["v1", "v2"],
    });
    if (result?.type !== "unsupportedVideos") {
      throw new Error("expected unsupportedVideos");
    }
    expect(unsupportedSelectionMessage(result).title).toMatch(/Multi-video/i);
  });

  it("rejects mixed image and video", () => {
    const map = new Map([
      ["i1", creation("i1", "image")],
      ["v1", creation("v1", "video")],
    ]);
    const result = classifyAssetSelection(["i1", "v1"], map);
    expect(result).toEqual({
      type: "unsupportedMixed",
      reason: "imageVideo",
    });
  });

  it("rejects selections that include audio", () => {
    const map = new Map([
      ["i1", creation("i1", "image")],
      ["a1", creation("a1", "audio")],
    ]);
    const result = classifyAssetSelection(["i1", "a1"], map);
    expect(result).toEqual({
      type: "unsupportedMixed",
      reason: "containsAudio",
    });
  });

  it("returns null while creations are still loading", () => {
    expect(classifyAssetSelection(["missing"], new Map())).toBeNull();
  });
});
