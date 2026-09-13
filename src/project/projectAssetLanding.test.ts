import { beforeEach, describe, expect, it, vi } from "vitest";
import { importLocalPaths, importProjectAssetPaths } from "../library/catalogClient";
import { importLocalPathsForProject } from "./projectAssetLanding";
import { loadStoredProjects } from "./projectStore";

vi.mock("../library/catalogClient", () => ({
  importProjectAssetPaths: vi.fn(),
  importLocalPaths: vi.fn(),
}));

vi.mock("./projectStore", () => ({
  loadStoredProjects: vi.fn(() => []),
}));

describe("backend-owned project asset landing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends only project identity and paths, never a frontend folder choice", async () => {
    const result = {
      imported: 1,
      cancelled: false,
      creations: [{ id: "export-1" } as never],
      status: {} as never,
    };
    vi.mocked(importProjectAssetPaths).mockResolvedValue(result);

    await expect(
      importLocalPathsForProject({
        paths: ["/cache/run.png"],
        projectId: "project-1",
      }),
    ).resolves.toBe(result);

    expect(importProjectAssetPaths).toHaveBeenCalledWith("project-1", [
      "/cache/run.png",
    ]);
    expect(importLocalPaths).not.toHaveBeenCalled();
  });

  it("imports without a v1 folder when the open project is v2", async () => {
    const result = {
      imported: 1,
      cancelled: false,
      creations: [{ id: "local-1" } as never],
      status: {} as never,
    };
    vi.mocked(loadStoredProjects).mockReturnValue([
      {
        id: "project-1",
        containerVersion: "v2",
        parasceneProjectId: "44",
      } as never,
    ]);
    vi.mocked(importLocalPaths).mockResolvedValue(result);

    await expect(
      importLocalPathsForProject({
        paths: ["/cache/run.png"],
        projectId: "project-1",
      }),
    ).resolves.toBe(result);

    expect(importLocalPaths).toHaveBeenCalledWith(["/cache/run.png"]);
    expect(importProjectAssetPaths).not.toHaveBeenCalled();
  });
});
