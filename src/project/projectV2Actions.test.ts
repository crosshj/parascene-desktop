import { beforeEach, describe, expect, it, vi } from "vitest";

const existingCreationIds = vi.hoisted(() =>
  vi.fn(async (ids: string[]) => ids),
);

vi.mock("../library/catalogClient", () => ({
  existingCreationIds: (ids: string[]) => existingCreationIds(ids),
}));

import {
  addBodyForCreationIds,
  catalogedCreationIdsToAdd,
  membershipIdsToAdd,
  mergeV2ProjectFolders,
  overlayV2RemoteMembership,
  removeBodyForCreationIds,
  seedItemsForCreate,
  syntheticFolderFromStoredV2,
} from "./projectV2Actions";
import { createStoredProject } from "./projectStore";

describe("projectV2Actions", () => {
  beforeEach(() => {
    existingCreationIds.mockReset();
    existingCreationIds.mockImplementation(async (ids) => ids);
  });

  it("seeds numeric ids and local:// items separately", () => {
    const seeded = seedItemsForCreate(["11", "disk-still"], "lib-a");
    expect(seeded.ids).toEqual(["11"]);
    expect(seeded.items).toEqual([
      {
        pointer: {
          kind: "local",
          uri: "local://lib-a/disk-still",
          libraryId: "lib-a",
          assetId: "disk-still",
        },
        cover: false,
      },
    ]);
    expect(addBodyForCreationIds(["11", "disk-still"], "lib-a")).toEqual([
      "11",
      {
        pointer: { kind: "local", uri: "local://lib-a/disk-still" },
      },
    ]);
    expect(removeBodyForCreationIds(["11", "disk-still"], "lib-a")).toEqual([
      "11",
      "local://lib-a/disk-still",
    ]);
  });

  it("does not PATCH-add an id that is already a list row", () => {
    expect(membershipIdsToAdd(["11", "296668"], ["296668", "22", "11"])).toEqual(
      ["22"],
    );
  });

  it("adds only cataloged ids when a sibling generate is still landing", async () => {
    existingCreationIds.mockImplementation(async (ids) =>
      ids.filter((id) => id !== "296610"),
    );
    await expect(
      catalogedCreationIdsToAdd(["music-1", "296610", ""]),
    ).resolves.toEqual(["music-1"]);
  });

  it("overlays remote membership without dropping in-flight placeholders", () => {
    const local = {
      ...createStoredProject("Trip", ["11"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      libraryAssetPlaceholders: {
        "ph-music": {
          id: "ph-music",
          kind: "audio" as const,
          aspectRatio: "16:9" as const,
          status: "generating" as const,
          addAssetDraft: { prompt: "theme" },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
    const remoteApplied = {
      ...createStoredProject("Trip renamed", ["11", "296610"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      coverCreationId: "11",
    };
    const next = overlayV2RemoteMembership(local, remoteApplied);
    expect(next.creationIds).toEqual(["11", "296610"]);
    expect(next.title).toBe("Trip renamed");
    expect(next.coverCreationId).toBe("11");
    expect(next.libraryAssetPlaceholders?.["ph-music"]?.id).toBe("ph-music");
  });

  it("builds a synthetic Library tile from a stored v2 project", () => {
    const project = {
      ...createStoredProject("Trip", ["11"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      lifecycle: "ready" as const,
    };
    const tile = syntheticFolderFromStoredV2(project);
    expect(tile?.id).toBe("project-v2-44");
    expect(tile?.kind).toBe("project");
    expect(tile?.projectId).toBe(project.id);
    expect(tile?.containerVersion).toBe("v2");
    expect(tile?.coverCreationId).toBe("11");
    expect(
      mergeV2ProjectFolders({ folders: [], storedProjects: [project] }).map(
        (folder) => folder.id,
      ),
    ).toEqual(["project-v2-44"]);
  });

  it("keeps the flagged cover when newer members are first in creationIds", () => {
    const project = {
      ...createStoredProject("Trip", ["22", "11"]),
      containerVersion: "v2" as const,
      parasceneProjectId: "44",
      coverCreationId: "11",
      lifecycle: "ready" as const,
    };
    expect(syntheticFolderFromStoredV2(project)?.coverCreationId).toBe("11");
    expect(
      syntheticFolderFromStoredV2(project, {
        remoteJson: JSON.stringify({
          id: 44,
          meta: {
            type: "project",
            group: {
              kind: "group_v2",
              items: [
                { pointer: { kind: "creation", creation_id: 22 } },
                { pointer: { kind: "creation", creation_id: 11 }, cover: true },
              ],
            },
          },
        }),
      })?.coverCreationId,
    ).toBe("11");
  });
});
