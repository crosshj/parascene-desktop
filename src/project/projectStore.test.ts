import { describe, expect, it, beforeEach } from "vitest";
import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  isIntentionalLegacyOpen,
  isTrulyLegacyProject,
  loadStoredProjects,
  loadStoredProjectsStrict,
  loadStoredProjectStrict,
  markStoredProjectLegacyOpen,
  deleteStoredProjectDocument,
  mergeCreationIds,
  partitionStoredProjects,
  removeCreationIds,
  renameStoredProject,
  repairMalformedTimelineClips,
  saveStoredProjects,
  saveStoredProjectsPreservingCorrupt,
  setStoredProjectAspectRatio,
  setStoredProjectSelectedTimelineClipId,
  setStoredProjectSelectedAssetId,
  setStoredProjectPendingStagedDraft,
  setStoredProjectTimeline,
  setStoredProjectTimelineZoom,
  setStoredProjectTimelineMonitorActive,
  setStoredProjectTimelinePlayheadSec,
  storedProjectToUi,
  setStoredProjectLabPrompts,
  setStoredProjectLyricAlignment,
  normalizeLyricAlignment,
  normalizeTimelineClip,
} from "./projectStore";

describe("projectStore", () => {
  beforeEach(() => {
    localStorage.removeItem(PROJECTS_STORAGE_KEY);
  });

  it("creates, saves, and loads projects", () => {
    const a = createStoredProject("Demo", ["c1", "c2"]);
    saveStoredProjects([a]);
    const loaded = loadStoredProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe("Demo");
    expect(loaded[0].creationIds).toEqual(["c1", "c2"]);
    expect(loaded[0].aspectRatio).toBe("16:9");
  });

  it("merges creation ids without duplicates", () => {
    const a = createStoredProject("Demo", ["c1"]);
    const merged = mergeCreationIds(a, ["c1", "c2"]);
    expect(merged.creationIds).toEqual(["c1", "c2"]);
  });

  it("defaults missing folder ids when loading older projects", () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "old",
          title: "Legacy",
          creationIds: ["c1"],
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    const loaded = loadStoredProjects();
    expect(loaded[0].folderIds).toEqual([]);
    expect(loaded[0].boundFolderId).toBeNull();
    expect(loaded[0].lifecycle).toBeUndefined();
    expect(isTrulyLegacyProject(loaded[0])).toBe(true);
    expect(isIntentionalLegacyOpen(loaded[0])).toBe(false);
    expect(storedProjectToUi(loaded[0]).folderIds).toEqual([]);
    expect(storedProjectToUi(loaded[0]).boundFolderId).toBeNull();
  });

  it("marks intentional legacy open without inventing a folder lifecycle", () => {
    const legacy = {
      ...createStoredProject("Old Trip"),
      lifecycle: undefined,
      folderSetupIssue: "blocked" as const,
    };
    delete (legacy as { lifecycle?: string }).lifecycle;
    expect(isTrulyLegacyProject(legacy)).toBe(true);
    expect(isTrulyLegacyProject(createStoredProject("New"))).toBe(false);
    expect(isTrulyLegacyProject({ lifecycle: "ready" })).toBe(false);

    const marked = markStoredProjectLegacyOpen(legacy);
    expect(marked.lifecycle).toBe("legacy");
    expect(marked.folderSetupIssue).toBeNull();
    expect(isIntentionalLegacyOpen(marked)).toBe(true);

    saveStoredProjects([marked]);
    expect(loadStoredProjects()[0].lifecycle).toBe("legacy");
  });

  it("deletes a project document and allows an empty list", () => {
    const only = createStoredProject("Gone");
    saveStoredProjects([only]);
    deleteStoredProjectDocument(only.id);
    expect(loadStoredProjects()).toEqual([]);
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBe("[]");
  });

  it("retains legacy folder evidence for open-time reconciliation", () => {
    const legacy = createStoredProject("Legacy");
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          ...legacy,
          folderIds: [" attached ", "attached", ""],
          boundFolderId: " bound ",
        },
      ]),
    );

    const [loaded] = loadStoredProjectsStrict();
    expect(loaded.folderIds).toEqual(["attached"]);
    expect(loaded.boundFolderId).toBe("bound");
  });

  it("strict loading rejects nested corruption instead of dropping references", () => {
    const project = createStoredProject("Unsafe", ["asset-1"]);
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          ...project,
          timeline: [
            {
              id: "broken-clip",
              label: "Broken",
              startSec: 5,
              endSec: 1,
              assetId: "asset-1",
            },
          ],
        },
      ]),
    );

    expect(() => loadStoredProjectsStrict()).toThrow(
      /timeline contains a malformed clip/i,
    );
  });

  it("partitions corrupt siblings so a healthy project can load strictly alone", () => {
    const healthy = createStoredProject("Healthy", ["asset-1"]);
    const corrupt = {
      ...createStoredProject("Broken", ["asset-2"]),
      timeline: [
        {
          id: "broken-clip",
          label: "Broken",
          startSec: 5,
          endSec: 1,
          assetId: "asset-2",
        },
      ],
    };
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([healthy, corrupt]),
    );

    expect(loadStoredProjects()).toHaveLength(2);
    const partitioned = partitionStoredProjects();
    expect(partitioned.projects.map((row) => row.id)).toEqual([healthy.id]);
    expect(partitioned.corrupt).toHaveLength(1);
    expect(partitioned.corrupt[0].id).toBe(corrupt.id);
    expect(partitioned.corrupt[0].error).toMatch(/malformed clip/i);

    expect(loadStoredProjectStrict(healthy.id).title).toBe("Healthy");
    expect(() => loadStoredProjectStrict(corrupt.id)).toThrow(
      new RegExp(corrupt.id),
    );
    expect(() => loadStoredProjectsStrict()).toThrow(/malformed clip/i);
  });

  it("repairs malformed timeline clips and then passes strict load", () => {
    const project = createStoredProject("Repairable", ["asset-1"]);
    const raw = {
      ...project,
      timeline: [
        {
          id: "good-clip",
          label: "Good",
          startSec: 0,
          endSec: 2,
          assetId: "asset-1",
          kind: "image",
        },
        {
          id: "broken-clip",
          label: "Broken",
          startSec: 5,
          endSec: 1,
          assetId: "asset-1",
        },
      ],
    };
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([raw]));

    const repaired = repairMalformedTimelineClips(raw);
    expect(repaired.timeline).toHaveLength(1);
    expect(repaired.timeline?.[0].id).toBe("good-clip");

    saveStoredProjectsPreservingCorrupt([repaired], [], [project.id]);
    expect(loadStoredProjectsStrict()).toHaveLength(1);
    expect(loadStoredProjectsStrict()[0].timeline).toHaveLength(1);
  });

  it("strict loading accepts normalizable legacy projects without lost refs", () => {
    const project = createStoredProject("Legacy", ["asset-1"]);
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          ...project,
          schemaVersion: undefined,
          documentRevision: undefined,
          timeline: [
            {
              id: "clip-1",
              label: "Clip",
              startSec: 0,
              endSec: 2,
              assetId: "asset-1",
              kind: "image",
            },
          ],
        },
      ]),
    );

    expect(loadStoredProjectsStrict()[0].timeline?.[0].assetId).toBe("asset-1");
  });

  it("removes creation ids and clears selected asset when needed", () => {
    let a = createStoredProject("Demo", ["c1", "c2"]);
    a = setStoredProjectSelectedAssetId(a, "c1");
    const next = removeCreationIds(a, ["c1"]);
    expect(next.creationIds).toEqual(["c2"]);
    expect(next.selectedAssetId).toBeNull();
  });

  it("removes timeline clips that reference deleted assets", () => {
    let a = createStoredProject("Demo", ["img1", "vid1"]);
    a = {
      ...a,
      timeline: [
        {
          id: "clip-a",
          label: "A",
          startSec: 0,
          endSec: 2,
          assetId: "img1",
          kind: "image",
        },
        {
          id: "clip-b",
          label: "B",
          startSec: 2,
          endSec: 4,
          assetId: "vid1",
          kind: "video",
        },
      ],
      mainAudioCreationId: "vid1",
    };
    const next = removeCreationIds(a, ["img1", "vid1"]);
    expect(next.creationIds).toEqual([]);
    expect(next.timeline).toEqual([]);
    expect(next.mainAudioCreationId).toBeNull();
  });

  it("renames a project", () => {
    const a = createStoredProject("Demo", ["c1"]);
    const renamed = renameStoredProject(a, "  Final cut  ");
    expect(renamed.title).toBe("Final cut");
    expect(renameStoredProject(a, "   ").title).toBe("Untitled project");
  });

  it("sets project aspect ratio", () => {
    const a = createStoredProject("Demo", ["c1"]);
    const next = setStoredProjectAspectRatio(a, "9:16");
    expect(next.aspectRatio).toBe("9:16");
    expect(storedProjectToUi(next).aspectRatio).toBe("9:16");
  });

  it("defaults missing aspect ratio when loading older projects", () => {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          id: "old",
          title: "Legacy",
          creationIds: [],
          updatedAt: "2020-01-01T00:00:00.000Z",
        },
      ]),
    );
    const loaded = loadStoredProjects();
    expect(loaded[0].aspectRatio).toBe("16:9");
  });

  it("persists timeline clips on the project", () => {
    const a = createStoredProject("Demo", ["c1"]);
    const withClips = setStoredProjectTimeline(a, [
      {
        id: "clip-1",
        label: "3.0s",
        startSec: 1,
        endSec: 4,
        assetId: "c1",
        lane: "video",
        kind: "image",
        inSec: 0,
        outSec: 3,
        includeAudio: false,
        transform: "hold",
        framing: "fit",
        thumbUrl: null,
      },
    ]);
    saveStoredProjects([withClips]);
    const loaded = loadStoredProjects();
    expect(loaded[0].timeline).toHaveLength(1);
    expect(loaded[0].timeline?.[0].startSec).toBe(1);
    expect(loaded[0].timeline?.[0].assetId).toBe("c1");
    expect(storedProjectToUi(loaded[0]).timeline[0].endSec).toBe(4);
  });

  it("round-trips addAssetGeneration and timelineLocked on timeline clips", () => {
    const clip = normalizeTimelineClip({
      id: "clip-gen",
      label: "0:09",
      startSec: 0,
      endSec: 9,
      assetId: "v1",
      timelineLocked: true,
      speed: 1.5,
      addAssetGeneration: {
        prompt: "Wave at camera",
        audioMode: "full_mix",
        lyricsText: "Hello world",
        generatedAt: "2026-07-22T12:00:00.000Z",
        creationId: "gen-99",
      },
    });
    expect(clip?.timelineLocked).toBe(true);
    expect(clip?.speed).toBe(1.5);
    expect(clip?.addAssetGeneration).toMatchObject({
      prompt: "Wave at camera",
      audioMode: "full_mix",
      lyricsText: "Hello world",
      generatedAt: "2026-07-22T12:00:00.000Z",
      creationId: "gen-99",
      mode: "start_frame",
    });
  });

  it("strips timelineLocked from audio clips so music stays movable", () => {
    const clip = normalizeTimelineClip({
      id: "song-1",
      label: "30.0s",
      startSec: 0,
      endSec: 30,
      assetId: "a1",
      kind: "audio",
      lane: "audio",
      timelineLocked: true,
    });
    expect(clip?.kind).toBe("audio");
    expect(clip?.timelineLocked).toBeUndefined();
  });

  it("round-trips addAssetDraft on placeholder clips", () => {
    const clip = normalizeTimelineClip({
      id: "ph-1",
      label: "0:09",
      startSec: 10,
      endSec: 19,
      isAddAssetPlaceholder: true,
      addAssetDraft: {
        prompt: "Pasted bridge prompt",
        audioMode: "vocals",
        continuityMode: "first_last",
        provider: "parascene_blue",
        methodId: "blue_timeline_fill",
      },
    });
    expect(clip?.addAssetDraft).toMatchObject({
      prompt: "Pasted bridge prompt",
      audioMode: "vocals",
      continuityMode: "first_last",
      provider: "parascene_blue",
      methodId: "blue_timeline_fill",
      lastFrameSource: { kind: "timeline" },
    });
  });

  it("persists slideshow recipe and bake metadata", () => {
    const a = createStoredProject("Demo", ["i1", "i2"]);
    const withClips = setStoredProjectTimeline(a, [
      {
        id: "clip-s",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        assetId: "i1",
        lane: "video",
        kind: "slideshow",
        inSec: 0,
        outSec: 10,
        framing: "fit",
        slideshow: {
          imageAssetIds: ["i1", "i2"],
          // Simulate a project saved before named beat algorithms existed.
          mode: "beat" as never,
          audioAssetId: "a1",
          audioInSec: 0,
          audioOutSec: 30,
          audioStartSec: 0,
          audioEndSec: 30,
        },
        bakeKey: "v1-abc",
        bakePath: "/Movies/Parascene/Cache/slideshows/v1/v1-abc.mp4",
      },
    ]);
    saveStoredProjects([withClips]);
    const clip = loadStoredProjects()[0].timeline?.[0];
    expect(clip?.kind).toBe("slideshow");
    expect(clip?.slideshow?.imageAssetIds).toEqual(["i1", "i2"]);
    expect(clip?.slideshow?.mode).toBe("beat_energy");
    expect(clip?.slideshow?.audioAssetId).toBe("a1");
    expect(clip?.bakeKey).toBe("v1-abc");
    expect(clip?.bakePath).toContain("slideshows");
  });

  it("keeps one-image slideshow clips when loading stored projects", () => {
    const a = createStoredProject("Demo", ["i1"]);
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          ...a,
          timeline: [
            {
              id: "clip-one",
              label: "2.5s",
              startSec: 0,
              endSec: 2.5,
              assetId: "i1",
              kind: "slideshow",
              slideshow: {
                imageAssetIds: ["i1"],
                mode: "beat_classic",
                audioAssetId: "a1",
              },
            },
          ],
        },
      ]),
    );
    const loaded = loadStoredProjectsStrict()[0];
    expect(loaded.timeline).toHaveLength(1);
    expect(loaded.timeline?.[0].kind).toBe("slideshow");
    expect(loaded.timeline?.[0].slideshow?.imageAssetIds).toEqual(["i1"]);
  });

  it("drops malformed slideshow clips without a valid recipe", () => {
    const a = createStoredProject("Demo", ["i1"]);
    const withClips = setStoredProjectTimeline(a, [
      {
        id: "clip-bad",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        kind: "slideshow",
        slideshow: { imageAssetIds: [], mode: "even" },
      } as never,
    ]);
    expect(withClips.timeline).toHaveLength(0);
  });

  it("persists random slideshow seed", () => {
    const a = createStoredProject("Demo", ["i1", "i2"]);
    const withClips = setStoredProjectTimeline(a, [
      {
        id: "clip-random",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["i1", "i2"],
          mode: "even",
          random: true,
          seed: 4294967295,
        },
      },
    ]);
    expect(withClips.timeline?.[0].slideshow).toEqual({
      imageAssetIds: ["i1", "i2"],
      mode: "even",
      random: true,
      seed: 4294967295,
    });
  });

  it("migrates legacy mode:random on load", () => {
    const a = createStoredProject("Demo", ["i1", "i2"]);
    const withClips = setStoredProjectTimeline(a, [
      {
        id: "clip-legacy-random",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["i1", "i2"],
          mode: "random",
          seed: 99,
        } as never,
      },
    ]);
    expect(withClips.timeline?.[0].slideshow).toEqual({
      imageAssetIds: ["i1", "i2"],
      mode: "even",
      random: true,
      seed: 99,
    });
  });

  it("persists selected timeline clip and zoom", () => {
    let a = createStoredProject("Demo", ["c1"]);
    a = setStoredProjectTimeline(a, [
      {
        id: "clip-1",
        label: "3.0s",
        startSec: 0,
        endSec: 3,
        assetId: "c1",
        lane: "video",
        kind: "image",
      },
    ]);
    a = setStoredProjectSelectedTimelineClipId(a, "clip-1");
    a = setStoredProjectTimelineZoom(a, 2.5);
    saveStoredProjects([a]);
    const loaded = loadStoredProjects()[0];
    expect(loaded.selectedTimelineClipId).toBe("clip-1");
    expect(loaded.timelineZoom).toBe(2.5);
    const ui = storedProjectToUi(loaded);
    expect(ui.selectedTimelineClipId).toBe("clip-1");
    expect(ui.timelineZoom).toBe(2.5);

    const cleared = setStoredProjectTimeline(loaded, []);
    expect(cleared.selectedTimelineClipId).toBeNull();
  });

  it("persists selected asset and clears timeline selection", () => {
    let a = createStoredProject("Demo", ["c1", "c2"]);
    a = setStoredProjectTimeline(a, [
      {
        id: "clip-1",
        label: "3.0s",
        startSec: 0,
        endSec: 3,
        assetId: "c1",
        lane: "video",
        kind: "image",
      },
    ]);
    a = setStoredProjectSelectedTimelineClipId(a, "clip-1");
    a = setStoredProjectSelectedAssetId(a, "c2");
    expect(a.selectedAssetId).toBe("c2");
    expect(a.selectedTimelineClipId).toBeNull();

    a = setStoredProjectSelectedTimelineClipId(a, "clip-1");
    expect(a.selectedTimelineClipId).toBe("clip-1");
    expect(a.selectedAssetId).toBeNull();

    saveStoredProjects([a]);
    const loaded = loadStoredProjects()[0];
    expect(storedProjectToUi(loaded).selectedTimelineClipId).toBe("clip-1");
    expect(storedProjectToUi(loaded).selectedAssetId).toBeNull();
  });

  it("persists timeline monitor active and playhead", () => {
    let a = createStoredProject("Demo", ["c1"]);
    a = setStoredProjectTimeline(a, [
      {
        id: "clip-1",
        label: "3.0s",
        startSec: 0,
        endSec: 3,
        assetId: "c1",
        lane: "video",
        kind: "image",
      },
    ]);
    a = setStoredProjectSelectedTimelineClipId(a, "clip-1");
    a = setStoredProjectTimelinePlayheadSec(a, 12.34);
    a = setStoredProjectTimelineMonitorActive(a, true);
    expect(a.timelineMonitorActive).toBe(true);
    expect(a.selectedTimelineClipId).toBeNull();
    expect(a.timelinePlayheadSec).toBe(12.34);

    saveStoredProjects([a]);
    const loaded = loadStoredProjects()[0];
    expect(loaded.timelineMonitorActive).toBe(true);
    expect(loaded.timelinePlayheadSec).toBe(12.34);
    const ui = storedProjectToUi(loaded);
    expect(ui.timelineMonitorActive).toBe(true);
    expect(ui.timelinePlayheadSec).toBe(12.34);
    expect(ui.selectedTimelineClipId).toBeNull();

    a = setStoredProjectSelectedTimelineClipId(loaded, "clip-1");
    expect(a.timelineMonitorActive).toBe(false);
    expect(a.selectedTimelineClipId).toBe("clip-1");
  });

  it("maps to UI project assets", () => {
    const a = createStoredProject("Demo", ["x"]);
    const ui = storedProjectToUi(a);
    expect(ui.title).toBe("Demo");
    expect(ui.aspectRatio).toBe("16:9");
    expect(ui.assets).toEqual([{ id: "x", name: "x", kind: "image" }]);
    expect(ui.scenes).toHaveLength(1);
  });

  it("persists pending source staged draft and clears it on clip select", () => {
    let a = createStoredProject("Demo", ["a1", "a2"]);
    a = setStoredProjectSelectedAssetId(a, "a1");
    const draft = {
      assetId: "a1",
      label: "Slideshow (2)",
      kind: "slideshow",
      inSec: 0,
      outSec: 10,
      includeAudio: false,
      reverse: false,
      transform: "hold",
      framing: "fit",
      slideshow: {
        imageAssetIds: ["a1", "a2"],
        mode: "beat_classic",
        sensitivity: 0.7,
      },
    };
    a = setStoredProjectPendingStagedDraft(a, draft);
    saveStoredProjects([a]);
    const loaded = loadStoredProjects()[0];
    expect(loaded.pendingStagedDraft).toEqual(draft);
    expect(storedProjectToUi(loaded).pendingStagedDraft).toEqual(draft);

    a = setStoredProjectTimeline(loaded, [
      {
        id: "clip-1",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        assetId: "a1",
        lane: "video",
        kind: "image",
      },
    ]);
    a = setStoredProjectSelectedTimelineClipId(a, "clip-1");
    expect(a.pendingStagedDraft).toBeNull();
  });

  it("keeps slideshow bake when a clip is moved or trimmed", () => {
    let a = createStoredProject("Demo", ["a1", "a2"]);
    a = setStoredProjectTimeline(a, [
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
          mode: "beat_grid",
        },
        bakeKey: "v3-abc",
        bakePath: "/tmp/bake.mp4",
      },
    ]);
    a = setStoredProjectTimeline(a, [
      {
        ...a.timeline![0],
        startSec: 2,
        endSec: 8,
        inSec: 2,
        outSec: 8,
      },
    ]);
    expect(a.timeline?.[0].bakeKey).toBe("v3-abc");
    expect(a.timeline?.[0].bakePath).toBe("/tmp/bake.mp4");
  });

  it("clears slideshow bake when its recipe changes", () => {
    let project = createStoredProject("Demo", ["a1", "a2"]);
    project = setStoredProjectTimeline(project, [
      {
        id: "clip-1",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        kind: "slideshow",
        slideshow: { imageAssetIds: ["a1", "a2"], mode: "even" },
        bakeKey: "v3-abc",
        bakePath: "/tmp/bake.mp4",
      },
    ]);
    project = setStoredProjectTimeline(project, [
      {
        ...project.timeline![0],
        slideshow: { imageAssetIds: ["a1", "a2"], mode: "beat_grid" },
      },
    ]);

    expect(project.timeline?.[0].bakeKey).toBeNull();
    expect(project.timeline?.[0].bakePath).toBeNull();
  });

  it("keeps a newly attached slideshow bake when recipe also changes", () => {
    let project = createStoredProject("Demo", ["a1", "a2"]);
    project = setStoredProjectTimeline(project, [
      {
        id: "clip-1",
        label: "10.0s",
        startSec: 0,
        endSec: 10,
        kind: "slideshow",
        slideshow: {
          imageAssetIds: ["a1", "a2"],
          mode: "beat_drums",
          random: true,
          seed: 1,
        },
        bakeKey: null,
        bakePath: null,
      },
    ]);
    // Bake completion: new seed/audio fields + fresh bakePath in one write.
    project = setStoredProjectTimeline(project, [
      {
        ...project.timeline![0],
        slideshow: {
          imageAssetIds: ["a1", "a2"],
          mode: "beat_drums",
          random: true,
          seed: 99,
          audioAssetId: "audio-1",
          audioInSec: 0,
          audioStartSec: 21,
          audioEndSec: 43,
        },
        bakeKey: "v3-fresh",
        bakePath: "/tmp/fresh-bake.mp4",
      },
    ]);

    expect(project.timeline?.[0].bakeKey).toBe("v3-fresh");
    expect(project.timeline?.[0].bakePath).toBe("/tmp/fresh-bake.mp4");
    expect(project.timeline?.[0].slideshow?.seed).toBe(99);
  });

  it("persists Lab still and animate prompts with the project", () => {
    let a = createStoredProject("Demo");
    expect(a.labStillPrompt).toBeNull();
    expect(a.labAnimatePrompt).toBeNull();

    a = setStoredProjectLabPrompts(a, {
      labStillPrompt: "  a custom still  ",
      labAnimatePrompt: "custom animate",
    });
    expect(a.labStillPrompt).toBe("  a custom still  ");
    expect(a.labAnimatePrompt).toBe("custom animate");

    saveStoredProjects([a]);
    const loaded = loadStoredProjects();
    expect(loaded[0].labStillPrompt).toBe("  a custom still  ");
    expect(loaded[0].labAnimatePrompt).toBe("custom animate");
    expect(storedProjectToUi(loaded[0]).labStillPrompt).toBe(
      "  a custom still  ",
    );

    a = setStoredProjectLabPrompts(loaded[0], { labStillPrompt: "" });
    expect(a.labStillPrompt).toBe("");
    expect(a.labAnimatePrompt).toBe("custom animate");
  });

  it("persists lyric text before timed lines exist", () => {
    let a = createStoredProject("Demo", ["audio-1"]);
    a = setStoredProjectLyricAlignment(a, {
      sourceAudioCreationId: "audio-1",
      lyricsText: "Verse one\nChorus",
      alignedAt: "2026-07-21T12:00:00.000Z",
      transcribeEngine: "openai",
      lines: [],
    });
    expect(a.lyricAlignment?.lyricsText).toBe("Verse one\nChorus");
    expect(a.lyricAlignment?.lines).toEqual([]);
    expect(
      normalizeLyricAlignment({
        sourceAudioCreationId: "audio-1",
        lyricsText: "draft",
        alignedAt: "2026-07-21T12:00:00.000Z",
        transcribeEngine: "local",
        lines: [],
      })?.lyricsText,
    ).toBe("draft");
  });

  it("preserves updated block timings when re-saving alignment", () => {
    let a = createStoredProject("Demo", ["audio-1"]);
    a = setStoredProjectLyricAlignment(a, {
      sourceAudioCreationId: "audio-1",
      lyricsText: "Line one",
      alignedAt: "2026-07-21T12:00:00.000Z",
      transcribeEngine: "openai",
      lines: [{ line: "Line one", startSec: 1, endSec: 2 }],
    });
    a = setStoredProjectLyricAlignment(a, {
      sourceAudioCreationId: "audio-1",
      lyricsText: "Line one",
      alignedAt: "2026-07-21T12:01:00.000Z",
      transcribeEngine: "openai",
      lines: [{ line: "Line one", startSec: 8.5, endSec: 11.25 }],
    });
    expect(a.lyricAlignment?.lines[0]).toMatchObject({
      line: "Line one",
      startSec: 8.5,
      endSec: 11.25,
    });
    saveStoredProjects([a]);
    expect(loadStoredProjects()[0].lyricAlignment?.lines[0]).toMatchObject({
      startSec: 8.5,
      endSec: 11.25,
    });
  });

  it("persists Whisper transcript with lyric alignment", () => {
    let a = createStoredProject("Demo", ["audio-1"]);
    a = setStoredProjectLyricAlignment(a, {
      sourceAudioCreationId: "audio-1",
      lyricsText: "Hello",
      alignedAt: "2026-07-21T12:00:00.000Z",
      transcribeEngine: "openai",
      lines: [{ line: "Hello", startSec: 0, endSec: 1 }],
      transcript: {
        engine: "openai",
        transcribedAt: "2026-07-21T11:59:00.000Z",
        vocalsPath: "/tmp/vocals.wav",
        fullText: "hello",
        language: "en",
        segments: [{ text: "hello", startSec: 0, endSec: 1 }],
        words: [{ word: "hello", startSec: 0, endSec: 1 }],
      },
    });
    expect(a.lyricAlignment?.transcript?.segments).toHaveLength(1);
    expect(a.lyricAlignment?.transcript?.words).toHaveLength(1);
    expect(a.lyricAlignment?.transcript?.vocalsPath).toBe("/tmp/vocals.wav");
    saveStoredProjects([a]);
    expect(loadStoredProjects()[0].lyricAlignment?.transcript?.fullText).toBe(
      "hello",
    );
  });
});
