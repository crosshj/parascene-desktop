import { describe, expect, it } from "vitest";
import {
  buildProductionManifest,
  validateAndFinalizeProposal,
} from "./storyboardPropose";
import { emptyStoryboardProposal } from "../project/storyboardNormalize";
import type { StoryboardBudget } from "../project/types";

const budget: StoryboardBudget = {
  plannedAt: "2026-01-01T00:00:00.000Z",
  model: "gpt-4.1",
  durationSec: 10,
  maxUniqueStills: 4,
  maxUniqueVideoMasters: 2,
  targetSceneCount: 3,
  reuseStrategy: "Reuse B-roll within verse groups.",
};

describe("validateAndFinalizeProposal", () => {
  it("tiles scenes to full duration and derives vocal slices", () => {
    const result = validateAndFinalizeProposal(
      {
        visualGroups: [
          {
            id: "vg-1",
            label: "Performance",
            basePromptHint: "Neon stage",
            productionMethod: "a2v_from_still",
          },
        ],
        scenes: [
          {
            id: "s1",
            startSec: 0,
            endSec: 4,
            shotType: "lip_sync_cu",
            visualGroupId: "vg-1",
            note: "Verse",
            promptHint: "Close on singer",
          },
          {
            id: "s2",
            startSec: 4,
            endSec: 8,
            shotType: "lip_sync_mcu",
            visualGroupId: "vg-1",
            note: "Chorus",
            promptHint: "Medium on singer",
          },
        ],
      },
      {
        durationSec: 10,
        budget,
        vocalActivity: [{ startSec: 0, endSec: 3 }],
      },
    );
    expect(result.scenes).toHaveLength(2);
    expect(result.scenes[0].startSec).toBe(0);
    expect(result.scenes[1].endSec).toBe(10);
    expect(result.scenes[0].vocalSlice).toEqual({ inSec: 0, outSec: 4 });
    expect(result.scenes[1].vocalSliceWarning).toMatch(/vocal activity/i);
  });
});

describe("buildProductionManifest", () => {
  it("includes locked concept and scenes", () => {
    const proposal = emptyStoryboardProposal({
      sourceAudioCreationId: "audio-1",
      durationSec: 60,
      aspectRatio: "9:16",
    });
    const manifest = buildProductionManifest({
      ...proposal,
      budget,
      scenes: [],
      visualGroups: [],
    });
    expect(manifest.durationSec).toBe(60);
    expect(manifest.aspectRatio).toBe("9:16");
    expect(manifest.budget).toEqual(budget);
  });
});
