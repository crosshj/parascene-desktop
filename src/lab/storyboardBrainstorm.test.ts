import { describe, expect, it } from "vitest";
import {
  applyLockedConcept,
  lockStoryboardConcept,
} from "./storyboardBrainstorm";
import { emptyStoryboardProposal } from "../project/storyboardNormalize";

describe("lockStoryboardConcept", () => {
  it("normalizes brainstorm option into StoryboardConcept", () => {
    const concept = lockStoryboardConcept({
      source: "brainstorm",
      option: {
        id: "opt-1",
        title: "Neon Alley",
        logline: "A singer walks rain-soaked streets.",
        visualApproach: "Single location, neon practicals",
        mood: "Melancholic",
        feasibilityScore: 82.4,
        feasibilityRationale: "One set, heavy reuse",
        tradeoffs: "Limited variety",
      },
    });
    expect(concept.source).toBe("brainstorm");
    expect(concept.optionId).toBe("opt-1");
    expect(concept.feasibilityScore).toBe(82);
    expect(concept.title).toBe("Neon Alley");
  });

  it("applies locked concept to proposal", () => {
    const base = emptyStoryboardProposal({
      sourceAudioCreationId: "audio-1",
      durationSec: 120,
      aspectRatio: "16:9",
    });
    const concept = lockStoryboardConcept({
      source: "manual",
      option: {
        title: "DIY",
        logline: "Home studio fantasy",
        visualApproach: "Practical lights",
        mood: "Intimate",
        feasibilityScore: 70,
        feasibilityRationale: "OK",
        tradeoffs: "",
      },
    });
    const next = applyLockedConcept(base, concept);
    expect(next.brainstorm.lockedConcept?.title).toBe("DIY");
    expect(next.logline).toBe("Home studio fantasy");
  });
});
