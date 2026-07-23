import { describe, expect, it } from "vitest";
import { emptyStoryboardProposal, normalizeStoryboardProposal } from "../project/storyboardNormalize";
import {
  countPlanProgress,
  defaultStillSourceForVideoStep,
  encodeStillSource,
  markStepDone,
  materializeStillSources,
  nextRunnableStep,
  proposalBuildFingerprint,
  reconcileGenerationPlan,
  resolveStoryboardBuildPlan,
  setStepStillSource,
  setVideoStepStillSource,
  stillSourceOptionsForStillStep,
  stepDependenciesMet,
} from "./storyboardBuildPlan";

const lipSyncProposal = {
  ...emptyStoryboardProposal({
    sourceAudioCreationId: "audio-1",
    durationSec: 50,
    aspectRatio: "9:16",
  }),
  visualGroups: [
    {
      id: "vg-1",
      label: "Performance",
      basePromptHint: "Studio",
      productionMethod: "a2v_from_still" as const,
    },
  ],
  scenes: [
    {
      id: "s1",
      startSec: 0,
      endSec: 10,
      shotType: "lip_sync_cu" as const,
      visualGroupId: "vg-1",
      note: "A",
      promptHint: "A",
    },
    {
      id: "s2",
      startSec: 36,
      endSec: 47,
      shotType: "lip_sync_cu" as const,
      visualGroupId: "vg-1",
      note: "B",
      promptHint: "B",
    },
  ],
};

describe("resolveStoryboardBuildPlan", () => {
  it("builds still + a2v + place steps for lip-sync groups", () => {
    const proposal = {
      ...lipSyncProposal,
      scenes: lipSyncProposal.scenes.slice(0, 1),
      durationSec: 10,
    };
    const steps = resolveStoryboardBuildPlan(proposal);
    expect(steps.some((s) => s.id === "still:vg-1")).toBe(true);
    expect(steps.filter((s) => s.kind === "a2v")).toHaveLength(1);
  });

  it("preserves done status across reconcile", () => {
    const proposal = {
      ...lipSyncProposal,
      scenes: lipSyncProposal.scenes.slice(0, 1),
    };
    const fingerprint = proposalBuildFingerprint(proposal);
    const withPlan = {
      ...proposal,
      generationPlan: {
        builtAt: "2026-01-01T00:00:00.000Z",
        proposalFingerprint: fingerprint,
        steps: [
          {
            id: "still:vg-1",
            kind: "create_still" as const,
            label: "Still",
            status: "done" as const,
            dependsOn: [],
            creationId: "img-1",
            completedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    const plan = reconcileGenerationPlan(withPlan);
    expect(plan.steps.find((s) => s.id === "still:vg-1")?.status).toBe("done");
  });
});

describe("video still source", () => {
  it("defaults second scene to previous clip frame", () => {
    const base = resolveStoryboardBuildPlan(lipSyncProposal);
    const a2v2 = base.find((s) => s.id === "a2v:scene-s2")!;
    const source = defaultStillSourceForVideoStep(
      a2v2,
      lipSyncProposal.scenes,
      base,
    );
    expect(source.mode).toBe("previous_video_frame");
  });

  it("defaults first scene to group still", () => {
    const base = resolveStoryboardBuildPlan(lipSyncProposal);
    const a2v1 = base.find((s) => s.id === "a2v:scene-s1")!;
    const source = defaultStillSourceForVideoStep(
      a2v1,
      lipSyncProposal.scenes,
      base,
    );
    expect(source.mode).toBe("group_still");
    expect(source.stillStepId).toBe("still:vg-1");
  });

  it("materializes pull_frame for previous-video source", () => {
    const base = resolveStoryboardBuildPlan(lipSyncProposal);
    const merged = base.map((s) =>
      s.id === "a2v:scene-s2"
        ? { ...s, stillSource: { mode: "previous_video_frame" as const } }
        : s,
    );
    const steps = materializeStillSources(merged, lipSyncProposal.scenes);
    expect(steps.find((s) => s.id === "frame:for-a2v:scene-s2")).toBeTruthy();
  });

  it("uses group still without pull_frame when selected", () => {
    const plan = setVideoStepStillSource(
      lipSyncProposal,
      "a2v:scene-s2",
      { mode: "group_still", stillStepId: "still:vg-1" },
    );
    expect(plan.steps.some((s) => s.kind === "pull_frame")).toBe(false);
    const a2v2 = plan.steps.find((s) => s.id === "a2v:scene-s2");
    expect(a2v2?.stillStepId).toBe("still:vg-1");
  });

  it("uses project image without pull_frame", () => {
    const plan = setVideoStepStillSource(lipSyncProposal, "a2v:scene-s2", {
      mode: "project_image",
      creationId: "img-99",
    });
    const a2v2 = plan.steps.find((s) => s.id === "a2v:scene-s2");
    expect(a2v2?.stillSource).toEqual({
      mode: "project_image",
      creationId: "img-99",
    });
    expect(a2v2?.dependsOn).toEqual([]);
  });

  it("encodes still source for select values", () => {
    expect(encodeStillSource({ mode: "prompt_only" })).toBe("none");
    expect(encodeStillSource({ mode: "previous_video_frame" })).toBe("prev");
    expect(
      encodeStillSource({ mode: "project_image", creationId: "42" }),
    ).toBe("img:42");
  });

  it("offers reference options for create_still steps", () => {
    const base = resolveStoryboardBuildPlan(lipSyncProposal);
    const still = base.find((s) => s.id === "still:vg-1")!;
    const options = stillSourceOptionsForStillStep(
      still,
      base,
      lipSyncProposal.scenes,
      [{ id: "img-1", title: "Hero still" }],
    );
    expect(options.some((o) => o.value === "none")).toBe(true);
    expect(options.some((o) => o.label.includes("Hero still"))).toBe(true);
    expect(options.some((o) => o.value === "prev")).toBe(false);
  });

  it("materializes pull_frame before still when using previous clip frame", () => {
    const proposal = {
      ...lipSyncProposal,
      visualGroups: [
        ...lipSyncProposal.visualGroups,
        {
          id: "vg-2",
          label: "Puppet",
          basePromptHint: "Puppet",
          productionMethod: "a2v_from_still" as const,
        },
      ],
      scenes: [
        ...lipSyncProposal.scenes,
        {
          id: "s3",
          startSec: 48,
          endSec: 55,
          shotType: "lip_sync_cu" as const,
          visualGroupId: "vg-2",
          note: "Puppet",
          promptHint: "Puppet",
        },
      ],
    };
    const plan = reconcileGenerationPlan(proposal);
    const puppetStill = plan.steps.find((s) => s.id === "still:vg-2")!;
    const withRef = setStepStillSource(proposal, puppetStill.id, {
      mode: "previous_video_frame",
    });
    const frameId = "frame:for-still:vg-2";
    expect(withRef.steps.some((s) => s.id === frameId)).toBe(true);
    const stillStep = withRef.steps.find((s) => s.id === "still:vg-2");
    expect(stillStep?.stillStepId).toBe(frameId);
    expect(stillStep?.dependsOn).toEqual([frameId]);
  });

  it("preserves pull_frame done status across reconcile", () => {
    const plan = reconcileGenerationPlan(lipSyncProposal);
    const frameId = "frame:for-a2v:scene-s2";
    expect(plan.steps.find((s) => s.id === frameId)?.status).toBe("pending");
    const donePlan = markStepDone(plan, frameId, "frame-img-1");
    const again = reconcileGenerationPlan({
      ...lipSyncProposal,
      generationPlan: donePlan,
    });
    expect(again.steps.find((s) => s.id === frameId)?.status).toBe("done");
    expect(again.steps.find((s) => s.id === frameId)?.creationId).toBe(
      "frame-img-1",
    );
  });

  it("round-trips pull_frame done through normalize and reconcile", () => {
    const plan = reconcileGenerationPlan(lipSyncProposal);
    const frameId = "frame:for-a2v:scene-s2";
    const donePlan = markStepDone(plan, frameId, "frame-img-1");
    const normalized = normalizeStoryboardProposal({
      ...lipSyncProposal,
      generationPlan: donePlan,
    });
    expect(normalized).not.toBeNull();
    const again = reconcileGenerationPlan(normalized!);
    expect(again.steps.find((s) => s.id === frameId)?.status).toBe("done");
  });
});

describe("nextRunnableStep", () => {
  it("returns still before a2v", () => {
    const proposal = {
      ...lipSyncProposal,
      scenes: lipSyncProposal.scenes.slice(0, 1),
      durationSec: 10,
    };
    const plan = reconcileGenerationPlan(proposal);
    expect(nextRunnableStep(plan)?.kind).toBe("create_still");
    expect(stepDependenciesMet(plan.steps[1]!, plan.steps)).toBe(false);
    expect(countPlanProgress(plan).total).toBeGreaterThan(0);
  });

  it("orders steps along the timeline", () => {
    const proposal = {
      ...emptyStoryboardProposal({
        sourceAudioCreationId: "audio-1",
        durationSec: 60,
        aspectRatio: "9:16" as const,
      }),
      visualGroups: [
        {
          id: "g-a",
          label: "A",
          basePromptHint: "A",
          productionMethod: "a2v_from_still" as const,
        },
        {
          id: "g-b",
          label: "B",
          basePromptHint: "B",
          productionMethod: "new_still" as const,
        },
      ],
      scenes: [
        {
          id: "s1",
          startSec: 0,
          endSec: 5,
          shotType: "lip_sync_cu" as const,
          visualGroupId: "g-a",
          note: "A1",
          promptHint: "A1",
        },
        {
          id: "s2",
          startSec: 10,
          endSec: 15,
          shotType: "metaphor_broll" as const,
          visualGroupId: "g-b",
          note: "B1",
          promptHint: "B1",
        },
        {
          id: "s3",
          startSec: 20,
          endSec: 25,
          shotType: "lip_sync_cu" as const,
          visualGroupId: "g-a",
          note: "A2",
          promptHint: "A2",
        },
      ],
    };
    const plan = reconcileGenerationPlan(proposal);
    const stillB = plan.steps.findIndex((s) => s.id === "still:g-b");
    const a2vS3 = plan.steps.findIndex((s) => s.id === "a2v:scene-s3");
    expect(stillB).toBeGreaterThan(-1);
    expect(a2vS3).toBeGreaterThan(-1);
    expect(stillB).toBeLessThan(a2vS3);
  });
});
