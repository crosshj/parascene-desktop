import { describe, expect, it } from "vitest";
import { createStoredProject, type StoredProject } from "./projectStore";
import { collectProjectAssetUsage } from "./projectUsage";

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
});
