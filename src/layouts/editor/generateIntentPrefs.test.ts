import { beforeEach, describe, expect, it } from "vitest";
import {
  GENERATE_INTENT_PREFS_KEY,
  loadLastGenerateIntent,
  saveLastGenerateIntent,
} from "./generateIntentPrefs";
import { makeAddAssetIntent } from "./previewIntent";

describe("generateIntentPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to image to video on Parascene", () => {
    expect(loadLastGenerateIntent()).toEqual(
      makeAddAssetIntent("image_to_video", "parascene_blue"),
    );
  });

  it("round-trips the last intent across projects", () => {
    saveLastGenerateIntent(
      makeAddAssetIntent("text_to_image", "replicate", "assets"),
    );
    expect(loadLastGenerateIntent()).toEqual(
      makeAddAssetIntent("text_to_image", "replicate", "assets"),
    );
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem(GENERATE_INTENT_PREFS_KEY, "{not-json");
    expect(loadLastGenerateIntent().intentId).toBe("image_to_video");
  });

  it("ignores unknown intent ids", () => {
    localStorage.setItem(
      GENERATE_INTENT_PREFS_KEY,
      JSON.stringify({ intentId: "nope", server: "replicate" }),
    );
    expect(loadLastGenerateIntent().intentId).toBe("image_to_video");
  });
});
