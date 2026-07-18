import { describe, expect, it } from "vitest";
import {
  filedIdSet,
  omitFiledCreations,
  remoteFoldersToCloudRows,
} from "./folderClient";

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
      },
    ]);
  });
});
