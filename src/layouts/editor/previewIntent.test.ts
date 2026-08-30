import { describe, expect, it } from "vitest";
import {
  GENERATE_INTENTS,
  GENERATE_SERVERS,
  SELECTION_INTENT_MODES,
  addAssetIntentAllowsLibraryGeneration,
  addAssetIntentAllowsTimelinePlacement,
  audioModeForIntent,
  intentOffersAssetsDestination,
  isIntentServerWired,
  makeAddAssetIntent,
  resolveAddAssetIntent,
  selectionModeAllowsTimelinePlacement,
  serversForIntent,
} from "./previewIntent";
import { addAssetDragDraftFromIntent } from "./stagedClip";

describe("previewIntent catalog", () => {
  it("lists intents and servers", () => {
    expect(GENERATE_INTENTS.length).toBe(9);
    expect(GENERATE_INTENTS.map((i) => i.id)).toContain("text_to_music");
    expect(GENERATE_INTENTS.map((i) => i.id)).toContain("text_to_speech");
    expect(GENERATE_SERVERS.map((s) => s.id)).toEqual([
      "parascene_blue",
      "blue_direct",
      "replicate",
    ]);
    expect(GENERATE_SERVERS.find((s) => s.id === "blue_direct")?.label).toBe(
      "Direct to Blue",
    );
    expect(SELECTION_INTENT_MODES.some((m) => m.id === "slideshow")).toBe(true);
  });

  it("marks music and speech as coming soon", () => {
    expect(
      serversForIntent("text_to_music").every((c) => c.status === "coming_soon"),
    ).toBe(true);
    expect(
      serversForIntent("text_to_speech").every(
        (c) => c.status === "coming_soon",
      ),
    ).toBe(true);
  });

  it("uses destination policy for placement vs assets", () => {
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("image_audio_to_video", "parascene_blue"),
      ),
    ).toBe(true);
    // Destination is action-based: video Place stays available even if prefs say assets.
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("text_to_video", "parascene_blue", "assets"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("text_to_video", "parascene_blue", "timeline"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsLibraryGeneration(
        makeAddAssetIntent("text_to_image", "replicate", "assets"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsLibraryGeneration(
        makeAddAssetIntent("text_to_image", "replicate", "timeline"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("text_to_image", "replicate"),
      ),
    ).toBe(false);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("image_to_image", "parascene_blue"),
      ),
    ).toBe(false);
  });

  it("wires core video intents on Parascene and Direct to Blue", () => {
    expect(isIntentServerWired("text_to_video", "parascene_blue")).toBe(true);
    expect(isIntentServerWired("text_to_video", "blue_direct")).toBe(true);
    expect(isIntentServerWired("image_to_video", "blue_direct")).toBe(true);
    expect(isIntentServerWired("image_audio_to_video", "parascene_blue")).toBe(
      true,
    );
    expect(isIntentServerWired("video_to_video", "parascene_blue")).toBe(true);
    expect(isIntentServerWired("video_to_video", "blue_direct")).toBe(false);
    expect(isIntentServerWired("reference_to_video", "parascene_blue")).toBe(
      false,
    );
    expect(isIntentServerWired("text_to_image", "parascene_blue")).toBe(true);
    expect(isIntentServerWired("image_to_image", "parascene_blue")).toBe(true);
    expect(isIntentServerWired("text_to_image", "replicate")).toBe(true);
    expect(isIntentServerWired("text_to_image", "blue_direct")).toBe(true);
  });

  it("gates timeline placement on wired timeline intents", () => {
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("image_to_video", "parascene_blue"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("image_to_video", "replicate"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("text_to_image", "replicate"),
      ),
    ).toBe(false);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("image_to_image", "replicate"),
      ),
    ).toBe(false);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("video_to_video", "parascene_blue"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsTimelinePlacement(
        makeAddAssetIntent("video_to_video", "blue_direct"),
      ),
    ).toBe(false);
    expect(selectionModeAllowsTimelinePlacement("slideshow")).toBe(true);
    expect(selectionModeAllowsTimelinePlacement("composite")).toBe(false);
  });

  it("marks still intents as assets-only", () => {
    const t2i = GENERATE_INTENTS.find((i) => i.id === "text_to_image");
    const i2i = GENERATE_INTENTS.find((i) => i.id === "image_to_image");
    expect(t2i?.destinationPolicy).toBe("assets_only");
    expect(i2i?.destinationPolicy).toBe("assets_only");
    expect(t2i?.label).toBe("Text to Image");
  });

  it("offers Generate Assets only for stills", () => {
    expect(intentOffersAssetsDestination("text_to_image")).toBe(true);
    expect(intentOffersAssetsDestination("image_to_image")).toBe(true);
    expect(intentOffersAssetsDestination("text_to_video")).toBe(false);
    expect(intentOffersAssetsDestination("image_to_video")).toBe(false);
    expect(intentOffersAssetsDestination("image_audio_to_video")).toBe(false);
    expect(intentOffersAssetsDestination("video_to_video")).toBe(false);
    expect(intentOffersAssetsDestination("reference_to_video")).toBe(false);
    expect(intentOffersAssetsDestination("text_to_music")).toBe(false);
    expect(intentOffersAssetsDestination("text_to_speech")).toBe(false);
  });

  it("wires Text to Image for library generation", () => {
    expect(
      addAssetIntentAllowsLibraryGeneration(
        makeAddAssetIntent("text_to_image", "replicate"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsLibraryGeneration(
        makeAddAssetIntent("text_to_image", "blue_direct"),
      ),
    ).toBe(true);
    expect(
      addAssetIntentAllowsLibraryGeneration(
        makeAddAssetIntent("image_to_video", "replicate"),
      ),
    ).toBe(false);
  });

  it("resolves legacy provider+method drafts", () => {
    expect(
      resolveAddAssetIntent({
        provider: "parascene_blue",
        methodId: "blue_timeline_fill",
        continuityMode: "none",
      }),
    ).toEqual(makeAddAssetIntent("text_to_video", "parascene_blue"));
    expect(
      resolveAddAssetIntent({
        provider: "replicate",
        methodId: "replicate_text_to_image",
      }),
    ).toEqual(makeAddAssetIntent("text_to_image", "replicate"));
  });

  it("lists servers per intent", () => {
    expect(
      serversForIntent("reference_to_video").every(
        (c) => c.status === "coming_soon",
      ),
    ).toBe(true);
  });

  it("embeds intent on add-asset drag drafts", () => {
    const draft = addAssetDragDraftFromIntent(
      makeAddAssetIntent("image_to_video", "parascene_blue"),
    );
    expect(draft.isAddAssetPlaceholder).toBe(true);
    expect(draft.addAssetDraft?.intentId).toBe("image_to_video");
    expect(draft.addAssetDraft?.server).toBe("parascene_blue");
    expect(draft.addAssetDraft?.provider).toBe("parascene_blue");
  });

  it("seeds start-frame asset on add-asset drag drafts", () => {
    const draft = addAssetDragDraftFromIntent(
      makeAddAssetIntent("image_to_video", "blue_direct"),
      { startFrameAssetId: "img-1", thumbUrl: "asset://t" },
    );
    expect(draft.thumbUrl).toBe("asset://t");
    expect(draft.addAssetDraft?.startFrameAssetId).toBe("img-1");
    expect(draft.addAssetDraft?.server).toBe("blue_direct");
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

  it("never seeds A2V source audio as none", () => {
    expect(audioModeForIntent("image_audio_to_video")).toBe("full_mix");
    expect(audioModeForIntent("image_audio_to_video", "none")).toBe("full_mix");
    expect(audioModeForIntent("image_audio_to_video", "vocals")).toBe("vocals");
    expect(audioModeForIntent("image_to_video", "full_mix")).toBe("none");
  });
});
