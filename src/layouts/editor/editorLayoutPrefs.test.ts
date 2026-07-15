import { beforeEach, describe, expect, it } from "vitest";
import {
  ASSETS_WIDTH_MAX,
  ASSETS_WIDTH_MIN,
  ASSISTANT_WIDTH_MAX,
  ASSISTANT_WIDTH_MIN,
  DEFAULT_EDITOR_LAYOUT_PREFS,
  EDITOR_LAYOUT_PREFS_KEY,
  PREVIEW_WIDTH_MIN,
  TIMELINE_HEIGHT_MIN,
  assetsWidthMax,
  assistantWidthMax,
  clampAssetsWidth,
  clampAssistantWidth,
  clampTimelineHeight,
  loadEditorLayoutPrefs,
  saveEditorLayoutPrefs,
} from "./editorLayoutPrefs";

describe("editorLayoutPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("clamps pane sizes to usable ranges", () => {
    expect(clampAssetsWidth(100)).toBe(ASSETS_WIDTH_MIN);
    expect(clampAssetsWidth(9999)).toBe(ASSETS_WIDTH_MAX);
    expect(clampAssistantWidth(100)).toBe(ASSISTANT_WIDTH_MIN);
    expect(clampAssistantWidth(9999)).toBe(ASSISTANT_WIDTH_MAX);
    expect(clampTimelineHeight(100)).toBe(TIMELINE_HEIGHT_MIN);
    expect(clampTimelineHeight(400, 600)).toBe(330);
  });

  it("lets assistant grow far across the workspace while keeping preview room", () => {
    expect(
      assistantWidthMax({ workspaceWidth: 1600, reservedLeft: 320 }),
    ).toBe(1600 - PREVIEW_WIDTH_MIN - 320);
    expect(
      clampAssistantWidth(1200, { workspaceWidth: 1600, reservedLeft: 320 }),
    ).toBe(1600 - PREVIEW_WIDTH_MIN - 320);
    expect(
      clampAssistantWidth(500, { workspaceWidth: 1600, reservedLeft: 320 }),
    ).toBe(500);
  });

  it("lets assets grow far across the workspace while keeping preview room", () => {
    expect(
      assetsWidthMax({ workspaceWidth: 1600, reservedRight: 360 }),
    ).toBe(1600 - PREVIEW_WIDTH_MIN - 360);
    expect(
      clampAssetsWidth(1400, { workspaceWidth: 1600, reservedRight: 360 }),
    ).toBe(1600 - PREVIEW_WIDTH_MIN - 360);
    expect(
      clampAssetsWidth(500, { workspaceWidth: 1600, reservedRight: 360 }),
    ).toBe(500);
  });

  it("loads defaults when nothing is stored", () => {
    expect(loadEditorLayoutPrefs()).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS);
  });

  it("persists and restores prefs", () => {
    saveEditorLayoutPrefs({
      assetsWidth: 900,
      assistantWidth: 340,
      timelineHeight: 260,
    });
    expect(localStorage.getItem(EDITOR_LAYOUT_PREFS_KEY)).toBeTruthy();
    expect(loadEditorLayoutPrefs()).toEqual({
      assetsWidth: 900,
      assistantWidth: 340,
      timelineHeight: 260,
    });
  });

  it("sanitizes corrupt stored prefs", () => {
    localStorage.setItem(EDITOR_LAYOUT_PREFS_KEY, "{not-json");
    expect(loadEditorLayoutPrefs()).toEqual(DEFAULT_EDITOR_LAYOUT_PREFS);

    localStorage.setItem(
      EDITOR_LAYOUT_PREFS_KEY,
      JSON.stringify({ assetsWidth: 50, assistantWidth: 900, timelineHeight: 10 }),
    );
    expect(loadEditorLayoutPrefs()).toEqual({
      assetsWidth: ASSETS_WIDTH_MIN,
      assistantWidth: 900,
      timelineHeight: TIMELINE_HEIGHT_MIN,
    });
  });
});
