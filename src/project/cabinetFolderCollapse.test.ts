import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getProjectFolder: vi.fn(),
  removeProjectAssetsChecked: vi.fn(),
  getCreations: vi.fn(),
}));

vi.mock("./projectFolderClient", () => ({
  getProjectFolder: native.getProjectFolder,
  removeProjectAssetsChecked: native.removeProjectAssetsChecked,
}));

vi.mock("../library/catalogClient", () => ({
  getCreations: native.getCreations,
}));

import { collapseCabinetMembersFromProjectFolder } from "./cabinetFolderCollapse";

describe("collapseCabinetMembersFromProjectFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unfiles cabinet members and leaves covers", async () => {
    native.getProjectFolder.mockResolvedValue({
      memberIds: ["cover-v", "vid-1", "vid-2", "local"],
    });
    native.getCreations.mockResolvedValue([
      {
        id: "cover-v",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: ["vid-1", "vid-2"],
            },
          },
        }),
      },
    ]);
    native.removeProjectAssetsChecked.mockResolvedValue({
      folder: { memberIds: ["cover-v", "local"] },
    });

    const result = await collapseCabinetMembersFromProjectFolder({
      projectId: "p1",
      imagesGroupId: null,
      videosGroupId: "cover-v",
    });

    expect(native.removeProjectAssetsChecked).toHaveBeenCalledWith("p1", [
      "vid-1",
      "vid-2",
    ]);
    expect(result.removedIds).toEqual(["vid-1", "vid-2"]);
    expect(result.memberIds).toEqual(["cover-v", "local"]);
  });

  it("no-ops when folder is already cover-only", async () => {
    native.getProjectFolder.mockResolvedValue({
      memberIds: ["cover-v", "local"],
    });
    native.getCreations.mockResolvedValue([
      {
        id: "cover-v",
        remoteJson: JSON.stringify({
          meta: {
            group: {
              kind: "group_creations",
              source_creation_ids: ["vid-1"],
            },
          },
        }),
      },
    ]);

    const result = await collapseCabinetMembersFromProjectFolder({
      projectId: "p1",
      imagesGroupId: null,
      videosGroupId: "cover-v",
    });

    expect(native.removeProjectAssetsChecked).not.toHaveBeenCalled();
    expect(result.removedIds).toEqual([]);
    expect(result.memberIds).toEqual(["cover-v", "local"]);
  });
});
