import { describe, expect, it } from "vitest";
import type { Project } from "../../project/types";
import {
  pendingDraftMatchesSelection,
  selectionFromProject,
} from "./editorSelection";
import type { StagedClipDraft } from "./stagedClip";

function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    title: "Demo",
    aspectRatio: "9:16",
    scenes: [],
    assets: [
      { id: "a1", name: "a1", kind: "image" },
      { id: "a2", name: "a2", kind: "image" },
    ],
    folderIds: [],
    imagesGroupId: null,
    videosGroupId: null,
    labStillPrompt: null,
    labAnimatePrompt: null,
    mainAudioCreationId: null,
    lyricAlignment: null,
    timeline: [
      {
        id: "clip-1",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        assetId: "a1",
        lane: "video",
        kind: "slideshow",
        inSec: 0,
        outSec: 10,
        framing: "fit",
        slideshow: {
          imageAssetIds: ["a1", "a2"],
          mode: "beat_energy",
          sensitivity: 0.8,
        },
      },
    ],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    pendingStagedDraft: null,
    timelineZoom: 1,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
    hookSuggestions: [],
    ...overrides,
  };
}

describe("selectionFromProject", () => {
  it("restores a selected timeline clip and its staging draft", () => {
    const next = selectionFromProject(
      baseProject({ selectedTimelineClipId: "clip-1" }),
    );
    expect(next.selectedClipId).toBe("clip-1");
    expect(next.selectedClipIds).toEqual(["clip-1"]);
    expect(next.clipStagingSeed?.draft.slideshow?.mode).toBe("beat_energy");
    expect(next.clipStagingSeed?.draft.slideshow?.sensitivity).toBe(0.8);
    expect(next.selectedAssetId).toBeNull();
    expect(next.pendingStagedDraft).toBeNull();
  });

  it("restores a multi-select slideshow pending draft with its asset ids", () => {
    const pending: StagedClipDraft = {
      assetId: "a1",
      label: "Slideshow (2)",
      kind: "slideshow",
      inSec: 0,
      outSec: 12,
      includeAudio: false,
      reverse: false,
      transform: "hold",
      framing: "fill",
      thumbUrl: null,
      slideshow: {
        imageAssetIds: ["a1", "a2"],
        mode: "beat_drums",
        sensitivity: 0.25,
        random: true,
        seed: 99,
      },
    };
    const next = selectionFromProject(
      baseProject({
        selectedAssetId: "a1",
        pendingStagedDraft: pending,
      }),
    );
    expect(next.selectedAssetIds).toEqual(["a1", "a2"]);
    expect(next.pendingStagedDraft?.slideshow?.mode).toBe("beat_drums");
    expect(next.pendingStagedDraft?.slideshow?.sensitivity).toBe(0.25);
    expect(next.pendingStagedDraft?.outSec).toBe(12);
    expect(next.clipStagingSeed).toBeNull();
  });

  it("drops a pending draft that no longer matches the selected asset", () => {
    const pending: StagedClipDraft = {
      assetId: "a2",
      label: "a2",
      kind: "image",
      inSec: 0,
      outSec: 10,
      includeAudio: false,
      reverse: false,
      transform: "hold",
      framing: "fit",
      thumbUrl: null,
    };
    const next = selectionFromProject(
      baseProject({
        selectedAssetId: "a1",
        pendingStagedDraft: pending,
      }),
    );
    expect(next.selectedAssetIds).toEqual(["a1"]);
    expect(next.pendingStagedDraft).toBeNull();
  });
});

describe("pendingDraftMatchesSelection", () => {
  it("matches slideshow drafts by ordered image ids", () => {
    const draft: StagedClipDraft = {
      assetId: "a1",
      label: "S",
      kind: "slideshow",
      inSec: 0,
      outSec: 10,
      includeAudio: false,
      reverse: false,
      transform: "hold",
      framing: "fit",
      thumbUrl: null,
      slideshow: { imageAssetIds: ["a1", "a2"], mode: "even" },
    };
    expect(pendingDraftMatchesSelection(draft, ["a1", "a2"])).toBe(true);
    expect(pendingDraftMatchesSelection(draft, ["a2", "a1"])).toBe(false);
  });
});
