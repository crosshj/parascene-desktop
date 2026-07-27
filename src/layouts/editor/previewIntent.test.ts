import { describe, expect, it } from "vitest";
import {
  ADD_ASSET_METHODS,
  ADD_ASSET_PROVIDERS,
  SELECTION_INTENT_MODES,
  addAssetIntentAllowsTimelinePlacement,
  addAssetMethodsForProvider,
  findAddAssetMethod,
  selectionModeAllowsTimelinePlacement,
} from "./previewIntent";
import { addAssetDragDraftFromIntent } from "./stagedClip";

describe("previewIntent catalog", () => {
  it("lists providers and methods", () => {
    expect(ADD_ASSET_PROVIDERS.length).toBeGreaterThanOrEqual(3);
    expect(ADD_ASSET_METHODS.some((m) => m.wired && m.placement === "timeline")).toBe(
      true,
    );
    expect(SELECTION_INTENT_MODES.some((m) => m.id === "slideshow")).toBe(true);
  });

  it("gates timeline placement on wired timeline methods", () => {
    expect(
      addAssetIntentAllowsTimelinePlacement({
        provider: "parascene_blue",
        methodId: "blue_timeline_fill",
      }),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement({
        provider: "replicate",
        methodId: "replicate_timeline_fill",
      }),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement({
        provider: "replicate",
        methodId: "replicate_text_to_image",
      }),
    ).toBe(false);
    expect(selectionModeAllowsTimelinePlacement("slideshow")).toBe(true);
    expect(selectionModeAllowsTimelinePlacement("composite")).toBe(false);
  });

  it("filters methods by provider", () => {
    const blue = addAssetMethodsForProvider("parascene_blue");
    expect(blue.every((m) => m.provider === "parascene_blue")).toBe(true);
    expect(findAddAssetMethod("blue_timeline_fill")?.wired).toBe(true);
  });

  it("embeds intent on add-asset drag drafts", () => {
    const draft = addAssetDragDraftFromIntent({
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
    expect(draft.isAddAssetPlaceholder).toBe(true);
    expect(draft.addAssetDraft).toEqual({
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
    });
  });
});
