import { describe, expect, it } from "vitest";
import {
  ADD_ASSET_METHODS,
  ADD_ASSET_PROVIDERS,
  SELECTION_INTENT_MODES,
  addAssetIntentAllowsLibraryGeneration,
  addAssetIntentAllowsTimelinePlacement,
  addAssetMethodsForProvider,
  findAddAssetMethod,
  selectionModeAllowsTimelinePlacement,
} from "./previewIntent";
import { addAssetDragDraftFromIntent } from "./stagedClip";

describe("previewIntent catalog", () => {
  it("lists providers and methods", () => {
    expect(ADD_ASSET_PROVIDERS.length).toBe(2);
    expect(ADD_ASSET_PROVIDERS.map((p) => p.id)).toEqual([
      "parascene_blue",
      "replicate",
    ]);
    expect(ADD_ASSET_PROVIDERS[0]?.label).toBe("Parascene");
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

  it("wires Replicate text → image for library generation only", () => {
    const method = findAddAssetMethod("replicate_text_to_image");
    expect(method?.wired).toBe(true);
    expect(method?.placement).toBe("none");
    expect(
      addAssetIntentAllowsLibraryGeneration({
        provider: "replicate",
        methodId: "replicate_text_to_image",
      }),
    ).toBe(true);
    expect(
      addAssetIntentAllowsLibraryGeneration({
        provider: "replicate",
        methodId: "replicate_timeline_fill",
      }),
    ).toBe(false);
    expect(
      addAssetIntentAllowsLibraryGeneration({
        provider: "replicate",
        methodId: "replicate_image_to_image",
      }),
    ).toBe(false);
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

  it("seeds start-frame asset on add-asset drag drafts", () => {
    const draft = addAssetDragDraftFromIntent(
      {
        provider: "parascene_blue",
        methodId: "blue_timeline_fill",
      },
      { startFrameAssetId: "img-1", thumbUrl: "asset://t" },
    );
    expect(draft.thumbUrl).toBe("asset://t");
    expect(draft.addAssetDraft).toEqual({
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
      startFrameAssetId: "img-1",
    });
  });

  it("marks generate-from-selection as wired without timeline placement", () => {
    const mode = SELECTION_INTENT_MODES.find(
      (m) => m.id === "generate_from_selection",
    );
    expect(mode?.wired).toBe(true);
    expect(selectionModeAllowsTimelinePlacement("generate_from_selection")).toBe(
      false,
    );
  });
});
