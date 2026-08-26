import { describe, expect, it } from "vitest";
import { resolveAddAssetTimelinePlacement } from "./addAssetTimelinePlacement";
import { ADD_ASSET_DRAG_DRAFT } from "./stagedClip";

describe("resolveAddAssetTimelinePlacement", () => {
  it("hides Place/Drag for still intents", () => {
    expect(
      resolveAddAssetTimelinePlacement({
        placed: false,
        intentId: "text_to_image",
        server: "replicate",
        draft: ADD_ASSET_DRAG_DRAFT,
        comingSoon: false,
        needsCreds: false,
        canPlace: true,
        timelineSoon: false,
      }).mode,
    ).toBe("hidden");
    expect(
      resolveAddAssetTimelinePlacement({
        placed: false,
        intentId: "image_to_image",
        server: "parascene_blue",
        draft: ADD_ASSET_DRAG_DRAFT,
        comingSoon: false,
        needsCreds: false,
        canPlace: false,
        timelineSoon: true,
      }).mode,
    ).toBe("hidden");
  });

  it("keeps Place/Drag active for wired video intents", () => {
    expect(
      resolveAddAssetTimelinePlacement({
        placed: false,
        intentId: "text_to_video",
        server: "parascene_blue",
        draft: ADD_ASSET_DRAG_DRAFT,
        comingSoon: false,
        needsCreds: false,
        canPlace: true,
        timelineSoon: false,
      }).mode,
    ).toBe("active");
  });
});
