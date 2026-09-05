import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  flushProjectStore,
  getProjectStoreSource,
  hydrateProjectStoreFromNative,
  loadStoredProjects,
  resetProjectStoreForTests,
  saveStoredProjects,
} from "./projectStore";

describe("projectStore native backend", () => {
  beforeEach(() => {
    resetProjectStoreForTests();
    localStorage.clear();
    invoke.mockReset();
  });

  it("loads migrated rows into memory and ignores localStorage", async () => {
    const project = createStoredProject("Native");
    invoke.mockResolvedValueOnce({ rows: [project] });
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([createStoredProject("Stale")]));
    await hydrateProjectStoreFromNative(null);
    expect(getProjectStoreSource()).toBe("native");
    expect(localStorage.getItem(PROJECTS_STORAGE_KEY)).toBeNull();
    expect(loadStoredProjects()[0].title).toBe("Native");
  });

  it("refuses an empty overwrite of native memory", async () => {
    const project = createStoredProject("Keep");
    invoke.mockResolvedValue({ rows: [project], ok: true, count: 1 });
    await hydrateProjectStoreFromNative(null);
    saveStoredProjects([]);
    expect(loadStoredProjects()).toHaveLength(1);
    expect(loadStoredProjects()[0].title).toBe("Keep");
  });

  it("persists native saves through projects_save", async () => {
    const first = createStoredProject("A");
    const second = createStoredProject("B");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "projects_migrate_and_load") return { rows: [first] };
      if (cmd === "projects_save") return { ok: true, count: 1 };
      throw new Error(cmd);
    });
    await hydrateProjectStoreFromNative(null);
    saveStoredProjects([second]);
    await flushProjectStore();
    expect(invoke).toHaveBeenCalledWith("projects_save", {
      request: { rows: [second], allowEmpty: false },
    });
    expect(loadStoredProjects()[0].title).toBe("B");
  });

  it("stays on localStorage when native migrate is unavailable", async () => {
    invoke.mockRejectedValueOnce(new Error("unexpected invoke"));
    const project = createStoredProject("Local");
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify([project]));
    await hydrateProjectStoreFromNative(null);
    expect(getProjectStoreSource()).toBe("local");
    expect(loadStoredProjects()[0].title).toBe("Local");
  });
});
