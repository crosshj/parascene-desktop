import { beforeEach, describe, expect, it, vi } from "vitest";

const getRemoteCreation = vi.fn();
const getProjectV2 = vi.fn();
const patchProjectV2 = vi.fn();
const getCreation = vi.fn();
const deleteLocal = vi.fn();
const removeFromFolder = vi.fn();
const deleteCreationViaService = vi.fn();
const ungroupCreationsViaService = vi.fn();

vi.mock("../services/parasceneCatalog", () => ({
  getRemoteCreation: (...args: unknown[]) => getRemoteCreation(...args),
  deleteCreationViaService: (...args: unknown[]) =>
    deleteCreationViaService(...args),
  ungroupCreationsViaService: (...args: unknown[]) =>
    ungroupCreationsViaService(...args),
}));

vi.mock("./projectV2Client", () => ({
  getProjectV2: (...args: unknown[]) => getProjectV2(...args),
  patchProjectV2: (...args: unknown[]) => patchProjectV2(...args),
}));

vi.mock("../library/catalogClient", () => ({
  getCreation: (...args: unknown[]) => getCreation(...args),
  deleteLocal: (...args: unknown[]) => deleteLocal(...args),
}));

vi.mock("../library/folderClient", () => ({
  removeFromFolder: (...args: unknown[]) => removeFromFolder(...args),
}));

import {
  assertWwwChildrenCleared,
  collectProjectWipeChildIds,
  isGoneError,
  projectWipeChildIds,
  wipeProjectChildren,
} from "./deleteProjectMedia";

function wwwProject(members: Array<{ id: string }>) {
  return {
    id: 99,
    title: "Trip",
    published: false,
    media_type: "image",
    filename: "project/99.json",
    meta: {
      type: "project",
      group: {
        kind: "group_creations",
        source_creations: members.map((member) => ({ id: member.id })),
      },
    },
  };
}

describe("projectWipeChildIds", () => {
  it("drops the project Creation, seed, and blanks", () => {
    expect(
      projectWipeChildIds([" 11 ", "28006", "99", "99", "", "22"], "99"),
    ).toEqual(["11", "22"]);
  });
});

describe("isGoneError", () => {
  it("treats 404/410 and missing catalog rows as already gone", () => {
    expect(isGoneError(new Error("get creation failed (404)"))).toBe(true);
    expect(isGoneError(new Error("delete creation failed (410)"))).toBe(true);
    expect(isGoneError(new Error("Creation 12 not found"))).toBe(true);
    expect(isGoneError(new Error("does not exist"))).toBe(true);
  });

  it("does not treat network or auth failures as gone", () => {
    expect(isGoneError(new Error("Failed to fetch"))).toBe(false);
    expect(isGoneError(new Error("get creation failed (401)"))).toBe(false);
    expect(isGoneError(new Error("delete creation failed (500)"))).toBe(false);
    expect(
      isGoneError(new Error("Parascene still lists 2 files in this project.")),
    ).toBe(false);
  });
});

describe("collectProjectWipeChildIds", () => {
  beforeEach(() => {
    getRemoteCreation.mockReset();
    getProjectV2.mockReset();
  });

  it("unions the www costume with desktop items and stored ids", async () => {
    getRemoteCreation.mockResolvedValue(wwwProject([{ id: "11" }]));
    getProjectV2.mockResolvedValue({
      id: "99",
      title: "Trip",
      items: [
        { pointer: { kind: "creation", creationId: "11" } },
        {
          pointer: {
            kind: "local",
            uri: "local://lib/local-a",
            libraryId: "lib",
            assetId: "local-a",
          },
        },
      ],
    });

    await expect(
      collectProjectWipeChildIds({
        parasceneProjectId: "99",
        storedCreationIds: ["22", "28006", "99"],
      }),
    ).resolves.toEqual(["22", "11", "local-a"]);
    expect(getRemoteCreation).toHaveBeenCalledWith("99", { view: "www" });
  });

  it("treats a missing www project as no remote members", async () => {
    getRemoteCreation.mockRejectedValue(new Error("get creation failed (404)"));
    getProjectV2.mockRejectedValue(new Error("get creation failed (404)"));
    await expect(
      collectProjectWipeChildIds({
        parasceneProjectId: "99",
        storedCreationIds: ["11"],
      }),
    ).resolves.toEqual(["11"]);
  });

  it("fails collect when the www lookup is not a missing row", async () => {
    getRemoteCreation.mockRejectedValue(new Error("get creation failed (500)"));
    await expect(
      collectProjectWipeChildIds({
        parasceneProjectId: "99",
        storedCreationIds: ["11"],
      }),
    ).rejects.toThrow("get creation failed (500)");
    expect(getProjectV2).not.toHaveBeenCalled();
  });
});

describe("assertWwwChildrenCleared", () => {
  beforeEach(() => {
    getRemoteCreation.mockReset();
  });

  it("passes when the costume is empty or the project is gone", async () => {
    getRemoteCreation.mockResolvedValueOnce(wwwProject([]));
    await expect(assertWwwChildrenCleared("99")).resolves.toBeUndefined();
    getRemoteCreation.mockRejectedValueOnce(
      new Error("get creation failed (404)"),
    );
    await expect(assertWwwChildrenCleared("99")).resolves.toBeUndefined();
  });

  it("fails when the website still lists files", async () => {
    getRemoteCreation.mockResolvedValue(wwwProject([{ id: "11" }, { id: "22" }]));
    await expect(assertWwwChildrenCleared("99")).rejects.toThrow(
      "Parascene still lists 2 files in this project.",
    );
  });
});

describe("wipeProjectChildren", () => {
  beforeEach(() => {
    getRemoteCreation.mockReset();
    getProjectV2.mockReset();
    patchProjectV2.mockReset();
    getCreation.mockReset();
    deleteLocal.mockReset();
    removeFromFolder.mockReset();
    deleteCreationViaService.mockReset();
    ungroupCreationsViaService.mockReset();
    getCreation.mockRejectedValue(new Error("Creation 11 not found"));
    deleteLocal.mockResolvedValue({});
    removeFromFolder.mockResolvedValue(undefined);
    deleteCreationViaService.mockResolvedValue(undefined);
    patchProjectV2.mockResolvedValue({ id: "99", items: [] });
  });

  it("clears the group, deletes children, and reports progress", async () => {
    getRemoteCreation
      .mockResolvedValueOnce(wwwProject([{ id: "11" }]))
      .mockResolvedValueOnce(wwwProject([]));
    getProjectV2.mockResolvedValue({
      id: "99",
      title: "Trip",
      items: [{ pointer: { kind: "creation", creationId: "11" } }],
    });
    const progress: string[] = [];

    await expect(
      wipeProjectChildren({
        parasceneProjectId: "99",
        onProgress: (message) => progress.push(message),
      }),
    ).resolves.toEqual(["11"]);

    expect(patchProjectV2).toHaveBeenCalledWith("99", { remove: ["11"] });
    expect(deleteCreationViaService).toHaveBeenCalledWith("11");
    expect(progress).toContain("Looking up files on Parascene…");
    expect(progress).toContain("Removing files from the project…");
    expect(progress).toContain("Deleting 1 of 1…");
    expect(progress).toContain("Checking Parascene…");
  });

  it("stops before the project when a child delete fails", async () => {
    getRemoteCreation.mockResolvedValue(wwwProject([{ id: "11" }]));
    getProjectV2.mockResolvedValue({
      id: "99",
      title: "Trip",
      items: [{ pointer: { kind: "creation", creationId: "11" } }],
    });
    deleteCreationViaService.mockRejectedValue(
      new Error("delete creation failed (500)"),
    );

    await expect(
      wipeProjectChildren({ parasceneProjectId: "99" }),
    ).rejects.toThrow("Deleted 0 of 1");
  });
});
