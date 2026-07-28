import { describe, expect, it } from "vitest";
import {
  ADD_ASSET_FIRST_LAST_AUDIO_NOTE,
  ADD_ASSET_NO_LYRICS_AUDIO_NOTE,
  buildAddAssetGenerationPrompt,
  addAssetGenerationExpectedMs,
  addAssetGenerationProgress,
  findTimelineGenerationForAsset,
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

describe("addAssetClipDurationSec", () => {
  it("reads and clamps the placeholder span", async () => {
    const {
      addAssetClipDurationSec,
      clampAddAssetDurationSec,
      ADD_ASSET_MIN_DURATION_SEC,
      ADD_ASSET_MAX_DURATION_SEC,
    } = await import("./stagedClip");
    expect(
      addAssetClipDurationSec({ startSec: 10, endSec: 14.5 }),
    ).toBe(4.5);
    expect(clampAddAssetDurationSec(1)).toBe(ADD_ASSET_MIN_DURATION_SEC);
    expect(clampAddAssetDurationSec(99)).toBe(ADD_ASSET_MAX_DURATION_SEC);
  });
});

describe("initialAddAssetGenerationSteps", () => {
  it("labels audio steps for full-mix sections", () => {
    const steps = initialAddAssetGenerationSteps("full_mix");
    expect(steps[0]?.label).toBe("Prepare audio slice");
    expect(steps[1]?.label).toBe("Upload audio clip");
  });

  it("uses still-only steps for first_last mode", () => {
    const steps = initialAddAssetGenerationSteps("vocals", "first_last");
    expect(steps.map((s) => s.id)).toEqual([
      "still",
      "end-still",
      "generate",
      "file",
    ]);
    expect(steps[0]?.label).toMatch(/first frame/i);
    expect(steps[1]?.label).toMatch(/last frame/i);
  });
});

describe("replaceAddAssetPlaceholderWithVideo", () => {
  const meta = {
    addAssetGeneration: {
      prompt: "Lip sync close-up",
      audioMode: "vocals" as const,
      lyricsText: "Hello",
      generatedAt: "2026-07-22T12:00:00.000Z",
      creationId: "gen-1",
      mode: "start_frame" as const,
      model: "ltx_a2v",
    },
  };

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
      { addAssetGeneration: meta.addAssetGeneration },
    );
    expect(next[1]).toMatchObject({
      id: "placeholder",
      startSec: 12,
      endSec: 21,
      assetId: "new-video",
      isAddAssetPlaceholder: undefined,
      timelineLocked: true,
      addAssetGeneration: meta.addAssetGeneration,
    });
    expect(next[0]).toEqual(timeline[0]);
  });

  it("leaves generation metadata unset when meta is omitted", () => {
    const timeline = [
      {
        id: "placeholder",
        lane: "video" as const,
        kind: "video" as const,
        label: "0:09",
        startSec: 0,
        endSec: 9,
        isAddAssetPlaceholder: true,
      },
    ];
    const next = replaceAddAssetPlaceholderWithVideo(
      timeline,
      "placeholder",
      "new-video",
    );
    expect(next[0]?.addAssetGeneration).toBeUndefined();
    expect(next[0]?.timelineLocked).toBe(true);
  });
});

describe("findTimelineGenerationForAsset", () => {
  it("finds generation by creationId or clip assetId", () => {
    const timeline = [
      {
        id: "c1",
        lane: "video" as const,
        kind: "video" as const,
        label: "4.0s",
        startSec: 0,
        endSec: 4,
        assetId: "gen-video",
        addAssetGeneration: {
          prompt: "creature walks",
          generatedAt: "2026-07-28T00:00:00.000Z",
          creationId: "gen-video",
          mode: "start_frame" as const,
          model: "vidu/q3-turbo",
        },
      },
    ];
    expect(findTimelineGenerationForAsset(timeline, "gen-video")?.generation.prompt).toBe(
      "creature walks",
    );
    expect(findTimelineGenerationForAsset(timeline, "missing")).toBeNull();
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

  it("scales expected wall time with clip duration (9s → 2.5 min)", () => {
    expect(addAssetGenerationExpectedMs(9)).toBe(ADD_ASSET_GENERATION_EXPECTED_MS);
    expect(addAssetGenerationExpectedMs(4.5)).toBe(
      ADD_ASSET_GENERATION_EXPECTED_MS / 2,
    );
    expect(addAssetGenerationExpectedMs(18)).toBe(
      (15 / 9) * ADD_ASSET_GENERATION_EXPECTED_MS,
    );
    const half = addAssetGenerationExpectedMs(4.5) / 2;
    expect(addAssetGenerationProgress(half, addAssetGenerationExpectedMs(4.5)).percent).toBe(
      50,
    );
  });
});

describe("ADD_ASSET_NO_LYRICS_AUDIO_NOTE", () => {
  it("mentions full mix", () => {
    expect(ADD_ASSET_NO_LYRICS_AUDIO_NOTE).toMatch(/full mix/i);
  });
});

describe("ADD_ASSET_FIRST_LAST_AUDIO_NOTE", () => {
  it("mentions that audio is unused", () => {
    expect(ADD_ASSET_FIRST_LAST_AUDIO_NOTE).toMatch(/does not use audio/i);
  });
});
