import { describe, expect, it } from "vitest";
import {
  ADD_ASSET_FIRST_LAST_AUDIO_NOTE,
  ADD_ASSET_NO_LYRICS_AUDIO_NOTE,
  buildAddAssetGenerationPrompt,
  addAssetGenerationExpectedMs,
  addAssetGenerationProgress,
  findTimelineGenerationForAsset,
  generatedClipShouldSyncToTimeline,
  attachAudioCreationRangeArgs,
  initialAddAssetGenerationSteps,
  replaceAddAssetPlaceholderWithVideo,
  resolveA2vSourceAudioMode,
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

describe("attachAudioCreationRangeArgs", () => {
  it("sends creation id and range only", () => {
    const args: Record<string, unknown> = { prompt: "x" };
    attachAudioCreationRangeArgs(args, {
      creationId: 27140,
      startSec: 8,
      durationSec: 9,
    });
    expect(args.audio_creation_id).toBe(27140);
    expect(args.audio_start_sec).toBe(8);
    expect(args.audio_duration_sec).toBe(9);
    expect(args).not.toHaveProperty("input_audio_urls");
    expect(args).not.toHaveProperty("audio_url");
    expect(args).not.toHaveProperty("audio_clip_id");
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

describe("resolveA2vSourceAudioMode", () => {
  it("never returns none", () => {
    expect(resolveA2vSourceAudioMode("none", "")).toBe("full_mix");
    expect(resolveA2vSourceAudioMode("none", "A verse")).toBe("vocals");
  });

  it("keeps full mix when lyrics exist", () => {
    expect(resolveA2vSourceAudioMode("full_mix", "A verse")).toBe("full_mix");
  });

  it("hides vocals when lyrics are absent", () => {
    expect(resolveA2vSourceAudioMode("vocals", "")).toBe("full_mix");
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
  it("labels audio steps for full-mix clip upload", () => {
    const steps = initialAddAssetGenerationSteps("full_mix");
    expect(steps[0]?.label).toBe("Prepare audio slice");
    expect(steps[1]?.label).toBe("Upload audio clip");
  });

  it("omits clip-upload steps for CDN Creation range", () => {
    const steps = initialAddAssetGenerationSteps("full_mix", "start_frame", {
      cdnAudioWindow: true,
    });
    expect(steps.map((s) => s.id)).toEqual(["still", "generate", "file"]);
    expect(steps.map((s) => s.label)).toEqual([
      "Prepare framed start still",
      "Generate video",
      "Add to project",
    ]);
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

  it("skips audio steps when source audio is none", () => {
    const steps = initialAddAssetGenerationSteps("none", "start_frame");
    expect(steps.map((s) => s.id)).toEqual(["still", "generate", "file"]);
  });

  it("skips stills for text-to-video (images none)", () => {
    const steps = initialAddAssetGenerationSteps("none", "none");
    expect(steps.map((s) => s.id)).toEqual(["generate", "file"]);
  });
});

describe("generatedClipShouldSyncToTimeline", () => {
  it("locks only when timeline song audio was used", () => {
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "start_frame",
        audioMode: "vocals",
        server: "blue_direct",
      }),
    ).toBe(true);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "start_frame",
        audioMode: "full_mix",
        server: "parascene_blue",
      }),
    ).toBe(true);
  });

  it("does not lock for frames-only or no timeline audio", () => {
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "start_frame",
      }),
    ).toBe(false);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "first_last",
      }),
    ).toBe(false);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "motion_match",
      }),
    ).toBe(false);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "none",
      }),
    ).toBe(false);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "start_frame",
        startFrameAssetId: "img-1",
        audioMode: "none",
      }),
    ).toBe(false);
    expect(
      generatedClipShouldSyncToTimeline({
        prompt: "x",
        generatedAt: "t",
        creationId: "c",
        mode: "start_frame",
        audioMode: "vocals",
        server: "replicate",
      }),
    ).toBe(false);
    expect(generatedClipShouldSyncToTimeline(undefined)).toBe(false);
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
    expect(next[0]?.timelineLocked).toBeUndefined();
  });

  it("does not sync text-to-video fills to the timeline", () => {
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
      {
        addAssetGeneration: {
          prompt: "A city at dusk",
          generatedAt: "2026-07-22T12:00:00.000Z",
          creationId: "gen-t2v",
          mode: "none",
          model: "ltx_t2v",
        },
      },
    );
    expect(next[0]?.timelineLocked).toBeUndefined();
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

describe("ADD_ASSET_WAN_AUDIO_NOTE", () => {
  it("explains WAN locks source audio", async () => {
    const { ADD_ASSET_WAN_AUDIO_NOTE: note } = await import("./addAssetGenerate");
    expect(note).toMatch(/WAN/i);
    expect(note).toMatch(/None/i);
  });
});

describe("ADD_ASSET_IMAGES_NONE_AUDIO_NOTE", () => {
  it("explains text-to-video locks source audio", async () => {
    const { ADD_ASSET_IMAGES_NONE_AUDIO_NOTE: note } = await import(
      "./addAssetGenerate"
    );
    expect(note).toMatch(/Text-to-video/i);
    expect(note).toMatch(/None/i);
  });
});
