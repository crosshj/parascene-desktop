import { describe, expect, it, beforeEach } from "vitest";
import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  loadStoredProjects,
  mergeCreationIds,
  renameStoredProject,
  saveStoredProjects,
  setStoredProjectAspectRatio,
  setStoredProjectSelectedTimelineClipId,
  setStoredProjectSelectedAssetId,
  setStoredProjectTimeline,
  setStoredProjectTimelineZoom,
  setStoredProjectTimelineMonitorActive,
  setStoredProjectTimelinePlayheadSec,
  storedProjectToUi,
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
});
