import { beforeEach, describe, expect, it, vi } from "vitest";
import { importProjectAssetPaths } from "../library/catalogClient";
import { importLocalPathsForProject } from "./boundFolderLanding";

vi.mock("../library/catalogClient", () => ({
  importProjectAssetPaths: vi.fn(),
}));
vi.mock("../library/folderClient", () => ({
  addToFolder: vi.fn(),
  getFolder: vi.fn(),
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
  });
});
