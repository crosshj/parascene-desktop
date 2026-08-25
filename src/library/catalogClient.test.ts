import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheCompositionRun,
  deleteCompositionRun,
  ensureCatalogCreation,
  existingCreationIds,
  importLocalPaths,
  isCatalogListFilterId,
  listCreationsForFilter,
  mergeCreationsById,
} from "./catalogClient";
import type { Creation } from "./types";

const invoke = vi.fn();
const getRemoteCreation = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../services/parasceneCatalog", () => ({
  getRemoteCreation: (...args: unknown[]) => getRemoteCreation(...args),
  uploadFitThumbnailToCloud: vi.fn(),
}));

function stubCreation(
  partial: Partial<Creation> & Pick<Creation, "id">,
): Creation {
  return {
    title: partial.title ?? partial.id,
    mediaType: partial.mediaType ?? "image",
    remoteUrl: partial.remoteUrl ?? null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: partial.createdAt ?? "2026-07-01T00:00:00Z",
    downloadState: "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-07-01T00:00:00Z",
    filename: null,
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: partial.remoteJson ?? null,
    ...partial,
  };
}

describe("catalogClient existingCreationIds", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("short-circuits empty lookups", async () => {
    await expect(existingCreationIds([])).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes the batched existence command", async () => {
    invoke.mockResolvedValueOnce(["2", "1"]);
    await expect(existingCreationIds(["1", "2", "3"])).resolves.toEqual([
      "2",
      "1",
    ]);
    expect(invoke).toHaveBeenCalledWith("library_existing_creation_ids", {
      ids: ["1", "2", "3"],
    });
  });
});

describe("catalogClient project imports", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("sends bound-folder membership in the same native import command", async () => {
    const result = { imported: 0, cancelled: false, creations: [], status: {} };
    invoke.mockResolvedValueOnce(result);

    await expect(importLocalPaths(["/tmp/output.png"], " folder-1 ")).resolves.toBe(result);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("library_import_local_paths", {
      paths: ["/tmp/output.png"],
      folderId: "folder-1",
    });
  });

  it("explicitly sends no folder for an unbound import", async () => {
    const result = { imported: 0, cancelled: false, creations: [], status: {} };
    invoke.mockResolvedValueOnce(result);

    await importLocalPaths(["/tmp/output.png"]);

    expect(invoke).toHaveBeenCalledWith("library_import_local_paths", {
      paths: ["/tmp/output.png"],
      folderId: null,
    });
  });

  it("keeps composition runs in cache without a Library import", async () => {
    invoke.mockResolvedValueOnce("/cache/composition-runs/sw-1/run.png");

    await expect(cacheCompositionRun("/runs/output.png", "sw-1")).resolves.toBe(
      "/cache/composition-runs/sw-1/run.png",
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("library_cache_composition_run", {
      sourcePath: "/runs/output.png",
      compositionId: "sw-1",
    });
  });

  it("deletes composition cache through its restricted native command", async () => {
    invoke.mockResolvedValueOnce(undefined);

    await deleteCompositionRun("/cache/composition-runs/sw-1/run.png");

    expect(invoke).toHaveBeenCalledWith("library_delete_composition_run", {
      path: "/cache/composition-runs/sw-1/run.png",
    });
  });
});

describe("listCreationsForFilter", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("invokes library_list_filter_creations", async () => {
    const rows = [stubCreation({ id: "a1", mediaType: "audio" })];
    invoke.mockResolvedValueOnce(rows);
    await expect(listCreationsForFilter("audio")).resolves.toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("library_list_filter_creations", {
      filter: "audio",
    });
  });

  it("recognizes catalog list filter ids", () => {
    expect(isCatalogListFilterId("audio")).toBe(true);
    expect(isCatalogListFilterId("localOnly")).toBe(true);
    expect(isCatalogListFilterId("video")).toBe(false);
    expect(isCatalogListFilterId("all")).toBe(false);
  });
});

describe("mergeCreationsById", () => {
  it("appends buried local-only rows missing from the newest page", () => {
    const page = [
      stubCreation({ id: "new-1", createdAt: "2026-07-20T00:00:00Z" }),
      stubCreation({ id: "new-2", createdAt: "2026-07-19T00:00:00Z" }),
    ];
    const localOnly = [
      stubCreation({
        id: "local-audio-1",
        title: "Take me back",
        mediaType: "audio",
        createdAt: "2026-07-15T21:37:00Z",
        remoteUrl: null,
        remoteJson: null,
      }),
      stubCreation({
        id: "new-1",
        createdAt: "2026-07-20T00:00:00Z",
      }),
    ];
    const merged = mergeCreationsById(page, localOnly);
    expect(merged.map((c) => c.id)).toEqual([
      "new-1",
      "new-2",
      "local-audio-1",
    ]);
  });

  it("returns a copy when nothing is missing", () => {
    const page = [stubCreation({ id: "a" })];
    const merged = mergeCreationsById(page, page);
    expect(merged).toEqual(page);
    expect(merged).not.toBe(page);
  });
});

describe("ensureCatalogCreation", () => {
  beforeEach(() => {
    invoke.mockReset();
    getRemoteCreation.mockReset();
  });

  it("does not call Parascene unless remote is opted in", async () => {
    invoke.mockRejectedValueOnce(new Error("not in catalog"));
    getRemoteCreation.mockResolvedValue({ id: "x" });
    await expect(ensureCatalogCreation("x")).rejects.toThrow(/not found/);
    expect(getRemoteCreation).not.toHaveBeenCalled();
  });

  it("hydrates from Parascene when remote is true and the local row is missing", async () => {
    const row = stubCreation({ id: "x" });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "library_get_creation") {
        if (getRemoteCreation.mock.calls.length > 0) return row;
        throw new Error("not in catalog");
      }
      if (cmd === "library_get_creations") return [];
      if (cmd === "library_apply_manifest") return {};
      throw new Error(`unexpected invoke ${cmd}`);
    });
    getRemoteCreation.mockResolvedValue({ id: "x" });
    await expect(ensureCatalogCreation("x", { remote: true })).resolves.toEqual(row);
    expect(getRemoteCreation).toHaveBeenCalledWith("x");
  });
});
