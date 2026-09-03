import { describe, expect, it } from "vitest";
import { createStoredProject, type StoredProject } from "./projectStore";
import {
  getStoredProjectParseCount,
  __resetStoredProjectParseCountForTests,
} from "./projectStore";
import {
  collectProjectAssetUsage,
  collectProjectReferencedCreationIds,
  describeMissingProjectReferences,
  formatMissingProjectReferenceLines,
  outsideOwnedReferenceIds,
  pruneMissingProjectReferences,
} from "./projectUsage";

describe("collectProjectAssetUsage", () => {
  it("covers timeline, slideshow, composition, audio, storyboard, and cabinets", () => {
    const project = createStoredProject("Usage");
    project.timeline = [
      {
        id: "clip",
        label: "Clip",
        startSec: 0,
        endSec: 2,
        assetId: "video",
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["image-a", "image-b"],
          audioAssetId: "slide-audio",
          mode: "even",
        },
        addAssetDraft: { startFrameAssetId: "draft-start-frame" },
        addAssetGeneration: {
          prompt: "Generate",
          generatedAt: "now",
          creationId: "generated-video",
          startFrameAssetId: "generation-start-frame",
        },
      },
    ];
    project.stillWorkstreams = [
      {
        id: "composition",
        title: "Comp",
        kind: "plate",
        recipe: {
          layout: "side_by_side",
          placement: "height_fill",
          aspectRatio: "1:1",
          resolution: 2048,
          framing: "fit",
          gapMode: "auto",
          gapPx: 64,
          marginPx: 0,
        },
        memberIds: ["member"],
        nodes: [
          {
            id: "node",
            creationId: "internal",
            parentNodeId: null,
            status: "selected",
            showOutside: false,
            createdAt: "now",
          },
          {
            id: "discarded",
            creationId: "gone",
            parentNodeId: null,
            status: "discarded",
            showOutside: false,
            createdAt: "now",
          },
        ],
        selectedNodeId: "node",
        updatedAt: "now",
      },
    ];
    project.mainAudioCreationId = "main-audio";
    project.lyricAlignment = {
      sourceAudioCreationId: "lyric-audio",
      lyricsText: "",
      alignedAt: "now",
      transcribeEngine: "local",
      lines: [],
    };
    project.storyboardProposal = {
      sourceAudioCreationId: "storyboard-audio",
      generationPlan: {
        builtAt: "now",
        proposalFingerprint: "fingerprint",
        steps: [
          {
            id: "step",
            kind: "still",
            label: "Storyboard still",
            status: "done",
            creationId: "storyboard-result",
            dependsOn: [],
            stillSource: {
              mode: "project_image",
              creationId: "storyboard-source-image",
            },
          },
        ],
      },
    } as unknown as StoredProject["storyboardProposal"];
    project.imagesGroupId = "images-cabinet";
    project.videosGroupId = "videos-cabinet";

    const ids = collectProjectAssetUsage(project).map((row) => row.creationId);
    expect(ids).toEqual(
      expect.arrayContaining([
        "video",
        "image-a",
        "image-b",
        "slide-audio",
        "draft-start-frame",
        "generated-video",
        "generation-start-frame",
        "member",
        "internal",
        "main-audio",
        "lyric-audio",
        "storyboard-audio",
        "storyboard-result",
        "storyboard-source-image",
        "images-cabinet",
        "videos-cabinet",
      ]),
    );
    expect(ids).not.toContain("gone");
  });

  it("describes and prunes missing references outside the asset browser", () => {
    const project = createStoredProject("Melting", ["keep"]);
    project.timeline = [
      {
        id: "clip",
        label: "4.0s",
        startSec: 0,
        endSec: 4,
        assetId: "gone-clip",
        kind: "video",
      },
    ];
    project.storyboardProposal = {
      sourceAudioCreationId: "audio",
      durationSec: 10,
      aspectRatio: "16:9",
      brainstorm: { turns: [] },
      visualGroups: [],
      scenes: [],
      generationPlan: {
        builtAt: "now",
        proposalFingerprint: "fp",
        steps: [
          {
            id: "step-1",
            kind: "still",
            label: "Shot 1",
            status: "done",
            creationId: "gone-sb",
            dependsOn: [],
          },
        ],
      },
    } as unknown as StoredProject["storyboardProposal"];
    project.imagesGroupId = "gone-cabinet";

    const refs = describeMissingProjectReferences(project, [
      "gone-clip",
      "gone-sb",
      "gone-cabinet",
      "not-used",
    ]);
    expect(refs.map((row) => row.creationId).sort()).toEqual([
      "gone-cabinet",
      "gone-clip",
      "gone-sb",
    ]);
    expect(formatMissingProjectReferenceLines(refs).join("\n")).toContain(
      "storyboard / MV Build",
    );

    const pruned = pruneMissingProjectReferences(project, [
      "gone-clip",
      "gone-sb",
      "gone-cabinet",
    ]);
    expect(pruned.timeline?.[0]?.assetId).toBe("");
    expect(pruned.storyboardProposal?.generationPlan?.steps[0]?.creationId).toBeUndefined();
    expect(pruned.imagesGroupId).toBeNull();
    expect(collectProjectReferencedCreationIds(pruned)).not.toContain("gone-clip");
  });

  it("computes outside references from the already-normalized project", () => {
    const project = createStoredProject("Usage");
    project.creationIds = ["owned"];
    project.timeline = [
      {
        id: "clip",
        label: "Clip",
        startSec: 0,
        endSec: 2,
        lane: "video",
        kind: "video",
        assetId: "outside-id",
      },
    ];
    const ui = {
      ...project,
      assets: [{ id: "owned" }],
    };
    expect(outsideOwnedReferenceIds(ui, [])).toEqual(["outside-id"]);
    expect(outsideOwnedReferenceIds(ui, ["outside-id"])).toEqual([]);
    __resetStoredProjectParseCountForTests();
    outsideOwnedReferenceIds(ui, []);
    expect(getStoredProjectParseCount()).toBe(0);
  });
});
