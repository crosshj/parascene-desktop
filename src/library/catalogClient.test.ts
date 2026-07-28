import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  existingCreationIds,
  isCatalogListFilterId,
  listCreationsForFilter,
  mergeCreationsById,
} from "./catalogClient";
import type { Creation } from "./types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
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
