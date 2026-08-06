import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectCreationIdsToMergeForProject,
  collectExtraneousExpandedGroupMemberIds,
  collectProjectGroupCoverIdsToRefresh,
  collectProtectedCreationIds,
} from "./reconcileProjectLibrary";
import type { StoredProject } from "./projectStore";
import type { LibraryFolder } from "../library/folderClient";

const getCreations = vi.fn();
const listFolders = vi.fn();
const listGroupMemberIds = vi.fn();

vi.mock("../library/catalogClient", () => ({
  getCreations: (...args: unknown[]) => getCreations(...args),
  listGroupMemberIds: (...args: unknown[]) => listGroupMemberIds(...args),
}));

vi.mock("../library/folderClient", () => ({
  listFolders: (...args: unknown[]) => listFolders(...args),
}));

function project(partial: Partial<StoredProject>): StoredProject {
  return {
    id: "p1",
    title: "Demo",
    creationIds: [],
    folderIds: [],
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...partial,
  };
}

function groupCover(id: string, memberIds: string[]) {
  return {
    id,
    title: `Group ${id}`,
    filename: `group/${id}.png`,
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: memberIds,
        },
      },
    }),
  };
}

describe("reconcileProjectLibrary", () => {
  beforeEach(() => {
    getCreations.mockReset();
    listFolders.mockReset();
    listGroupMemberIds.mockReset();
  });

  it("collects cabinet and folder group covers to refresh", async () => {
    const folders: LibraryFolder[] = [
      {
        id: "f1",
        title: "Folder",
        description: "",
        createdAt: "",
        updatedAt: "",
        memberIds: ["50", "99"],
        memberCount: 2,
        kind: "regular",
        projectId: null,
      },
    ];
    getCreations.mockResolvedValue([
      groupCover("50", ["201", "202"]),
      { id: "99", title: "Still", filename: "99.png", remoteJson: null },
    ]);

    const ids = await collectProjectGroupCoverIdsToRefresh(
      [
        project({
          imagesGroupId: "10",
          folderIds: ["f1"],
        }),
      ],
      folders,
    );

    expect(ids.sort()).toEqual(["10", "50"]);
  });

  it("merges folder covers and cabinet members, but not ordinary group members", async () => {
    const folders: LibraryFolder[] = [
      {
        id: "f1",
        title: "Folder",
        description: "",
        createdAt: "",
        updatedAt: "",
        memberIds: ["50"],
        memberCount: 1,
        kind: "regular",
        projectId: null,
      },
    ];
    getCreations.mockResolvedValue([
      groupCover("10", ["101", "102"]),
      groupCover("50", ["201"]),
      { id: "99", title: "Already", filename: "99.png", remoteJson: null },
    ]);

    const missing = await collectCreationIdsToMergeForProject(
      project({
        creationIds: ["10", "99"],
        imagesGroupId: "10",
        folderIds: ["f1"],
      }),
      folders,
    );

    // Cabinet 10 → members 101/102; folder → cover 50 only (not 201).
    expect(missing.sort()).toEqual(["101", "102", "50"]);
    expect(getCreations).toHaveBeenCalledWith(["10"]);
  });

  it("flags ordinary group members for cleanup, keeping protected and cabinet ids", async () => {
    const folders: LibraryFolder[] = [
      {
        id: "f1",
        title: "Folder",
        description: "",
        createdAt: "",
        updatedAt: "",
        memberIds: ["50"],
        memberCount: 1,
        kind: "regular",
        projectId: null,
      },
    ];
    getCreations.mockImplementation(async (ids: string[]) => {
      const all = [
        groupCover("10", ["101", "102"]),
        groupCover("50", ["201", "202"]),
      ];
      const want = new Set(ids);
      return all.filter((row) => want.has(row.id));
    });
    // Catalog index: members of every group (cabinets + ordinary).
    listGroupMemberIds.mockResolvedValue(["101", "102", "201", "202"]);

    const stored = project({
      creationIds: ["10", "50", "101", "201", "202", "999"],
      imagesGroupId: "10",
      folderIds: ["f1"],
      timeline: [
        {
          id: "c1",
          label: "Keep",
          startSec: 0,
          endSec: 2,
          assetId: "202",
        },
      ],
    });

    expect([...collectProtectedCreationIds(stored)]).toEqual(["202"]);

    const extraneous = await collectExtraneousExpandedGroupMemberIds(
      stored,
      folders,
    );
    // 201 is an ordinary group member and unused; 202 is on the timeline.
    // 101 is a cabinet member; 999 was never in a group.
    expect(extraneous.sort()).toEqual(["201"]);
  });

  it("strips ordinary group members even when the cover is not on the project", async () => {
    listFolders.mockResolvedValue([]);
    getCreations.mockResolvedValue([]);
    listGroupMemberIds.mockResolvedValue(["201", "202"]);

    const extraneous = await collectExtraneousExpandedGroupMemberIds(
      project({
        creationIds: ["201", "202", "999"],
      }),
    );

    expect(extraneous.sort()).toEqual(["201", "202"]);
  });
});
