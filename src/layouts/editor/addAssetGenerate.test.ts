import { describe, expect, it } from "vitest";
import {
  ADD_ASSET_NO_LYRICS_AUDIO_NOTE,
  buildAddAssetGenerationPrompt,
  addAssetGenerationProgress,
  initialAddAssetGenerationSteps,
  replaceAddAssetPlaceholderWithVideo,
  resolveAddAssetAudioMode,
  ADD_ASSET_GENERATION_EXPECTED_MS,
} from "./addAssetGenerate";

describe("buildAddAssetGenerationPrompt", () => {
  it("returns the trimmed user prompt", () => {
    expect(buildAddAssetGenerationPrompt("  Lip sync close-up  ")).toBe(
      "Lip sync close-up",
    );
  });
});

describe("resolveAddAssetAudioMode", () => {
  it("uses vocals when lyrics are present", () => {
    expect(resolveAddAssetAudioMode("Line one")).toBe("vocals");
  });

  it("uses the full mix when lyrics are absent", () => {
    expect(resolveAddAssetAudioMode("  ")).toBe("full_mix");
  });
});

describe("initialAddAssetGenerationSteps", () => {
  it("labels audio steps for full-mix sections", () => {
    const steps = initialAddAssetGenerationSteps("full_mix");
    expect(steps[0]?.label).toBe("Prepare audio slice");
    expect(steps[1]?.label).toBe("Upload audio clip");
  });
});

describe("replaceAddAssetPlaceholderWithVideo", () => {
  it("keeps the clip on the timeline where the user left it", () => {
    const timeline = [
      {
        id: "a",
        lane: "video" as const,
        kind: "video" as const,
        label: "0:03",
        startSec: 0,
        endSec: 3,
        assetId: "prev",
      },
      {
        id: "placeholder",
        lane: "video" as const,
        kind: "video" as const,
        label: "0:09",
        startSec: 12,
        endSec: 21,
        isAddAssetPlaceholder: true,
      },
    ];
    const next = replaceAddAssetPlaceholderWithVideo(
      timeline,
      "placeholder",
      "new-video",
    );
    expect(next[1]).toMatchObject({
      id: "placeholder",
      startSec: 12,
      endSec: 21,
      assetId: "new-video",
      isAddAssetPlaceholder: undefined,
    });
    expect(next[0]).toEqual(timeline[0]);
  });
});

describe("addAssetGenerationProgress", () => {
  it("ramps to 100% over the expected duration", () => {
    expect(
      addAssetGenerationProgress(ADD_ASSET_GENERATION_EXPECTED_MS / 2).percent,
    ).toBe(50);
    expect(
      addAssetGenerationProgress(ADD_ASSET_GENERATION_EXPECTED_MS).indeterminate,
    ).toBe(true);
  });
});

describe("ADD_ASSET_NO_LYRICS_AUDIO_NOTE", () => {
  it("mentions full mix", () => {
    expect(ADD_ASSET_NO_LYRICS_AUDIO_NOTE).toMatch(/full mix/i);
  });
});
