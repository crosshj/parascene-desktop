import { describe, expect, it } from "vitest";
import { resolveLibraryGroupAddTarget } from "./libraryGroupAddTarget";

describe("resolveLibraryGroupAddTarget", () => {
  const membership = new Map([["in-group", { groupId: "g-img" }]]);

  const groupCover = {
    id: "g-img",
    title: "My pack",
    mediaType: "image",
    filename: "group/cover.png",
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: ["in-group"],
        },
      },
    }),
  } as never;

  it("adds loose images when a group member is also selected", () => {
    expect(
      resolveLibraryGroupAddTarget({
        assetIds: ["in-group", "loose-1", "loose-2"],
        groupMembershipByMemberId: membership,
        creationsById: {
          "g-img": groupCover as never,
          "loose-1": { id: "loose-1", mediaType: "image" } as never,
          "loose-2": { id: "loose-2", mediaType: "image" } as never,
        },
      }),
    ).toEqual({
      groupId: "g-img",
      groupLabel: "My pack",
      memberMediaKind: "image",
      memberIds: ["loose-1", "loose-2"],
    });
  });

  it("adds loose images when the group cover is selected", () => {
    expect(
      resolveLibraryGroupAddTarget({
        assetIds: ["g-img", "loose-1"],
        creationsById: {
          "g-img": groupCover as never,
          "loose-1": { id: "loose-1", mediaType: "image" } as never,
        },
      }),
    ).toEqual({
      groupId: "g-img",
      groupLabel: "My pack",
      memberMediaKind: "image",
      memberIds: ["loose-1"],
    });
  });

  it("does not infer a group from loose-only selections", () => {
    expect(
      resolveLibraryGroupAddTarget({
        assetIds: ["loose-1"],
        groupMembershipByMemberId: membership,
        creationsById: {
          "g-img": groupCover as never,
          "loose-1": { id: "loose-1", mediaType: "image" } as never,
        },
      }),
    ).toBeNull();
  });

  it("rejects mixed image and video loose selections", () => {
    expect(
      resolveLibraryGroupAddTarget({
        assetIds: ["g-img", "loose-1", "loose-v"],
        creationsById: {
          "g-img": groupCover as never,
          "loose-1": { id: "loose-1", mediaType: "image" } as never,
          "loose-v": { id: "loose-v", mediaType: "video" } as never,
        },
      }),
    ).toBeNull();
  });
});
