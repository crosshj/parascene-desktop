import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import {
  aliveAssetIdsForSelection,
  collectCabinetDisplayMemberIds,
} from "./cabinetDisplay";

function groupCover(id: string, memberIds: string[]): Creation {
  return {
    id,
    title: `Group ${id}`,
    mediaType: "image",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    filename: null,
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
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

describe("cabinetDisplay", () => {
  it("collects display members from cabinet covers without the cover id", () => {
    expect(
      collectCabinetDisplayMemberIds([
        groupCover("images-cover", ["m1", "m2", "images-cover"]),
        groupCover("videos-cover", ["m2", "m3"]),
      ]),
    ).toEqual(["m1", "m2", "m3"]);
  });

  it("treats cabinet display members as alive for selection without project ownership", () => {
    const alive = aliveAssetIdsForSelection(["cover", "solo"], ["m1", "m2"]);
    expect(alive.has("cover")).toBe(true);
    expect(alive.has("solo")).toBe(true);
    expect(alive.has("m1")).toBe(true);
    expect(alive.has("m2")).toBe(true);
    expect(alive.has("other")).toBe(false);
  });
});
