import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_SHELL_SESSION,
  SHELL_SESSION_KEY,
  loadShellSession,
  saveShellSession,
} from "./shellSession";

describe("shellSession", () => {
  beforeEach(() => {
    localStorage.removeItem(SHELL_SESSION_KEY);
  });

  it("returns defaults when empty", () => {
    expect(loadShellSession(new Set())).toEqual(DEFAULT_SHELL_SESSION);
  });

  it("round-trips a snapshot", () => {
    const snapshot = {
      ...DEFAULT_SHELL_SESSION,
      primaryTab: "project" as const,
      librarySurface: "sync" as const,
      mode: "editor" as const,
      openProjectId: "p1",
      selectedSceneId: "p1-scene-1",
      leftCollapsed: true,
      creationsFilterId: "video" as const,
    };
    saveShellSession(snapshot);
    expect(loadShellSession(new Set(["p1"]))).toEqual(snapshot);
  });

  it("drops openProjectId when the project is gone", () => {
    saveShellSession({
      ...DEFAULT_SHELL_SESSION,
      primaryTab: "project",
      mode: "hook",
      openProjectId: "missing",
      selectedSceneId: "missing-scene-1",
      creationsFilterId: "inProject",
    });
    const loaded = loadShellSession(new Set(["other"]));
    expect(loaded.openProjectId).toBeNull();
    expect(loaded.selectedSceneId).toBeNull();
    expect(loaded.primaryTab).toBe("project");
    expect(loaded.mode).toBe("hook");
    expect(loaded.creationsFilterId).toBe("all");
  });

  it("restores creations filter id", () => {
    saveShellSession({
      ...DEFAULT_SHELL_SESSION,
      creationsFilterId: "aspect916",
    });
    expect(loadShellSession(new Set()).creationsFilterId).toBe("aspect916");
  });

  it("ignores corrupt json", () => {
    localStorage.setItem(SHELL_SESSION_KEY, "{not-json");
    expect(loadShellSession(new Set())).toEqual(DEFAULT_SHELL_SESSION);
  });
});
