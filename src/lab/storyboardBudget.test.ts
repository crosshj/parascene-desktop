import { describe, expect, it } from "vitest";
import { hasLockedStoryboardConcept, hasStoryboardBudget } from "../project/storyboardNormalize";
import { applyLockedConcept, lockStoryboardConcept } from "./storyboardBrainstorm";
import { emptyStoryboardProposal } from "../project/storyboardNormalize";
import { parseBudget } from "./storyboardBudget";

describe("parseBudget", () => {
  it("parses flat budget JSON", () => {
    const budget = parseBudget(
      JSON.stringify({
        maxUniqueStills: 4,
        maxUniqueVideoMasters: 2,
        targetSceneCount: 16,
        reuseStrategy: "Reuse neon overlays across verses.",
      }),
      120,
    );
    expect(budget?.maxUniqueStills).toBe(4);
    expect(budget?.reuseStrategy).toMatch(/neon/i);
  });

  it("unwraps nested budget object from model", () => {
    const budget = parseBudget(
      JSON.stringify({
        budget: {
          max_unique_stills: 3,
          max_unique_video_masters: 2,
          target_scene_count: 14,
          reuse_strategy: "One studio still, loop B-roll.",
        },
      }),
      90,
    );
    expect(budget?.maxUniqueStills).toBe(3);
    expect(budget?.targetSceneCount).toBe(14);
  });
});

describe("storyboard budget gates", () => {
  it("detects locked concept and budget on proposal", () => {
    const base = emptyStoryboardProposal({
      sourceAudioCreationId: "a1",
      durationSec: 90,
      aspectRatio: "16:9",
    });
    expect(hasLockedStoryboardConcept(base)).toBe(false);
    expect(hasStoryboardBudget(base)).toBe(false);

    const withConcept = applyLockedConcept(
      base,
      lockStoryboardConcept({
        source: "manual",
        option: {
          title: "Test",
          logline: "Line",
          visualApproach: "Visual",
          mood: "Mood",
          feasibilityScore: 80,
          feasibilityRationale: "Fine",
          tradeoffs: "",
        },
      }),
    );
    expect(hasLockedStoryboardConcept(withConcept)).toBe(true);

    const withBudget = {
      ...withConcept,
      budget: {
        plannedAt: "2026-01-01T00:00:00.000Z",
        model: "gpt-4.1",
        durationSec: 90,
        maxUniqueStills: 3,
        maxUniqueVideoMasters: 2,
        targetSceneCount: 12,
        reuseStrategy: "Reuse",
      },
    };
    expect(hasStoryboardBudget(withBudget)).toBe(true);
  });
});
