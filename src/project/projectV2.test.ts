import { describe, expect, it } from "vitest";
import {
  assetIdsFromProjectV2Items,
  collectProjectV2MemberIds,
  coverAssetIdFromV2Items,
  isProjectV2Creation,
  omitProjectV2Creations,
  isStoredProjectV2,
  localUri,
  parseLocalUri,
  parseProjectV2Remote,
  v2FolderId,
} from "./projectV2";

describe("projectV2", () => {
  it("treats only containerVersion v2 with a Parascene id as v2", () => {
    expect(isStoredProjectV2({ containerVersion: "v2", parasceneProjectId: "44" })).toBe(true);
    expect(isStoredProjectV2({ containerVersion: "v1", parasceneProjectId: "44" })).toBe(false);
    expect(isStoredProjectV2({ containerVersion: "v2", parasceneProjectId: null })).toBe(false);
  });

  it("parses local:// and keeps other-library pointers off this catalog", () => {
    expect(parseLocalUri("local://lib-a/still-1")).toEqual({
      uri: "local://lib-a/still-1",
      libraryId: "lib-a",
      assetId: "still-1",
    });
    expect(localUri("lib-a", "still-1")).toBe("local://lib-a/still-1");
    const items = parseProjectV2Remote({
      id: 99,
      type: "project",
      meta: {
        type: "project",
        group: {
          kind: "group_v2",
          items: [
            { pointer: { kind: "creation", creation_id: 11 }, cover: true },
            { pointer: { kind: "local", uri: "local://other/x" } },
            { pointer: { kind: "local", uri: "local://lib-a/y" } },
          ],
        },
      },
    });
    expect(assetIdsFromProjectV2Items(items?.items ?? [], "lib-a")).toEqual([
      "11",
      "local://other/x",
      "y",
    ]);
    expect(coverAssetIdFromV2Items(items?.items ?? [], "lib-a")).toBe("11");
    expect(
      coverAssetIdFromV2Items(
        [
          { ...items!.items[2], cover: false },
          { ...items!.items[0], cover: true },
        ],
        "lib-a",
      ),
    ).toBe("11");
  });

  it("hides creation-pointer members of a v2 project tile", () => {
    const project = {
      id: "99",
      filename: "project/1_x",
      remoteJson: JSON.stringify({
        id: 99,
        meta: {
          type: "project",
          group: {
            kind: "group_v2",
            items: [{ pointer: { kind: "creation", creation_id: 11 } }],
          },
        },
      }),
    };
    expect(isProjectV2Creation(project)).toBe(true);
    expect([...collectProjectV2MemberIds([project])]).toEqual(["11"]);
    expect(v2FolderId("99")).toBe("project-v2-99");
  });

  it("does not treat a bare group v2 as a project", () => {
    expect(
      parseProjectV2Remote({
        id: 7,
        meta: { group: { kind: "group_v2", items: [] } },
      }),
    ).toBeNull();
  });

  it("omits project v2 tiles from the home creation grid", () => {
    expect(
      omitProjectV2Creations([
        { id: "11", filename: "still.png" },
        { id: "99", filename: "project/1_x" },
      ]).map((row) => row.id),
    ).toEqual(["11"]);
  });
});
