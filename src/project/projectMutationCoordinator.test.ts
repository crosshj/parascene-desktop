import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  existingCreationIds: vi.fn<(ids: string[]) => Promise<string[]>>(),
  markProjectUsageStale: vi.fn<() => Promise<void>>(),
  repairProjectUsage: vi.fn<() => Promise<void>>(),
  replaceProjectUsage: vi.fn<() => Promise<void>>(),
}));

vi.mock("../library/catalogClient", () => ({
  existingCreationIds: native.existingCreationIds,
}));

vi.mock("./projectFolderClient", () => ({
  markProjectUsageStale: native.markProjectUsageStale,
  repairProjectUsage: native.repairProjectUsage,
  replaceProjectUsage: native.replaceProjectUsage,
}));

import {
  PROJECTS_STORAGE_KEY,
  createStoredProject,
  loadStoredProjectsStrict,
  saveStoredProjects,
} from "./projectStore";
import { mutateStoredProjects } from "./projectMutationCoordinator";

describe("projectMutationCoordinator", () => {
  beforeEach(() => {
    localStorage.removeItem(PROJECTS_STORAGE_KEY);
    vi.clearAllMocks();
    native.existingCreationIds.mockImplementation(async (ids) => ids);
    native.markProjectUsageStale.mockResolvedValue();
    native.repairProjectUsage.mockResolvedValue();
    native.replaceProjectUsage.mockResolvedValue();
  });

  it("rejects a newly owned creation that disappeared before the document commit", async () => {
    const project = { ...createStoredProject("Race"), lifecycle: "ready" as const };
    saveStoredProjects([project]);
    native.existingCreationIds.mockResolvedValue([]);

    await expect(
      mutateStoredProjects((projects) =>
        projects.map((row) => ({ ...row, creationIds: ["deleted-result"] })),
      ),
    ).rejects.toThrow("deleted-result");

    expect(loadStoredProjectsStrict()[0].creationIds).toEqual([]);
    expect(native.markProjectUsageStale).not.toHaveBeenCalled();
  });

  it("persists a newly owned creation when the catalog still contains it", async () => {
    const project = { ...createStoredProject("Safe"), lifecycle: "ready" as const };
    saveStoredProjects([project]);

    const next = await mutateStoredProjects((projects) =>
      projects.map((row) => ({ ...row, creationIds: ["result-1"] })),
    );

    expect(next[0].creationIds).toEqual(["result-1"]);
    expect(native.existingCreationIds).toHaveBeenCalledWith(["result-1"]);
    expect(native.markProjectUsageStale).toHaveBeenCalledOnce();
    expect(native.replaceProjectUsage).toHaveBeenCalledOnce();
  });
});
