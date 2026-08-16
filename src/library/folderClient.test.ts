import { describe, expect, it } from "vitest";
import {
  coverCreationIdFromFolderMeta,
  desktopFolderMeta,
  filedIdSet,
  isEmptyRegularFolder,
  omitFiledCreations,
  projectIdFromFolderMeta,
  remoteFoldersToCloudRows,
} from "./folderClient";

describe("isEmptyRegularFolder", () => {
  it("allows deleting empty regular folders only", () => {
    expect(
      isEmptyRegularFolder({ kind: "regular", memberCount: 0 }),
    ).toBe(true);
    expect(
      isEmptyRegularFolder({ kind: "regular", memberCount: 1 }),
    ).toBe(false);
    expect(
      isEmptyRegularFolder({ kind: "project", memberCount: 0 }),
    ).toBe(false);
  });
});

describe("omitFiledCreations", () => {
  it("hides creations that belong to a folder", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const filed = filedIdSet(["b"]);
    expect(omitFiledCreations(rows, filed).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("returns all when nothing is filed", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(omitFiledCreations(rows, new Set()).map((r) => r.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("remoteFoldersToCloudRows", () => {
  it("maps API snake_case folders into local camelCase rows", () => {
    expect(
      remoteFoldersToCloudRows([
        {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Favorites",
          description: "keep",
          created_at: "2026-07-18T20:00:00.000Z",
          updated_at: "2026-07-18T20:05:00.000Z",
          creation_ids: [101, 102],
          member_count: 2,
          meta: {},
        },
      ]),
    ).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Favorites",
        description: "keep",
        createdAt: "2026-07-18T20:00:00.000Z",
        updatedAt: "2026-07-18T20:05:00.000Z",
        creationIds: ["101", "102"],
        memberCount: 2,
        meta: {},
      },
    ]);
  });

  it("reads the opaque desktop project marker without treating other metadata as ownership", () => {
    expect(
      projectIdFromFolderMeta({
        parascene_desktop: { project_id: "project-1" },
        color: "blue",
      }),
    ).toBe("project-1");
    expect(projectIdFromFolderMeta({ color: "blue" })).toBeNull();
  });

  it("reads and builds cover_creation_id in desktop folder meta", () => {
    expect(
      coverCreationIdFromFolderMeta({
        parascene_desktop: {
          project_id: "project-1",
          cover_creation_id: "18848",
        },
      }),
    ).toBe("18848");
    expect(
      desktopFolderMeta({
        projectId: "project-1",
        coverCreationId: "18848",
      }),
    ).toEqual({
      parascene_desktop: {
        project_id: "project-1",
        cover_creation_id: "18848",
      },
    });
    expect(desktopFolderMeta({ coverCreationId: "9" })).toEqual({
      parascene_desktop: { cover_creation_id: "9" },
    });
    expect(desktopFolderMeta({})).toEqual({});
  });
});
