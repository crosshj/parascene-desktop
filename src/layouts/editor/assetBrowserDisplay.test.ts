import { describe, expect, it } from "vitest";
import type { Creation } from "../../library/types";
import type { ProjectAsset } from "../../project/types";
import { flattenProjectAssetsForBrowserDisplay } from "./assetBrowserDisplay";

const PROJECT_ID = "project-1";
const PROJECT_TITLE = "The More I Know";

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
    filename: `group/${id}.png`,
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

function desktopImagesCover(id: string, memberIds: string[]): Creation {
  return {
    ...groupCover(id, memberIds),
    title: `Parascene Desktop · ${PROJECT_TITLE} · Images`,
    remoteJson: JSON.stringify({
      meta: {
        group: {
          kind: "group_creations",
          source_creation_ids: memberIds,
        },
        desktop: {
          role: "project_images",
          client: "parascene-desktop",
          projectId: PROJECT_ID,
        },
      },
    }),
  };
}

function still(id: string): Creation {
  return {
    ...groupCover(id, []),
    filename: `${id}.png`,
    remoteJson: null,
    mediaType: "image",
  };
}

function asset(id: string, kind: ProjectAsset["kind"] = "image"): ProjectAsset {
  return { id, name: id, kind };
}

describe("flattenProjectAssetsForBrowserDisplay", () => {
  it("expands the store-pointer container even without a desktop stamp", () => {
    const imagesCover = "images-cabinet";
    const rootAssets = [asset(imagesCover), asset("solo")];
    const creationsById = {
      [imagesCover]: groupCover(imagesCover, ["m1", "m2"]),
      m1: still("m1"),
      m2: still("m2"),
      solo: still("solo"),
    };

    expect(
      flattenProjectAssetsForBrowserDisplay({
        projectId: PROJECT_ID,
        projectTitle: PROJECT_TITLE,
        rootAssets,
        creationsById,
        projectCabinets: { imagesGroupId: imagesCover, videosGroupId: null },
      }).map((row) => row.id),
    ).toEqual(["m1", "m2", "solo"]);
  });

  it("expands a party-named Images container when the store pointer is missing", () => {
    const imagesCover = "images-cabinet";
    const rootAssets = [asset(imagesCover), asset("solo")];
    const creationsById = {
      [imagesCover]: {
        ...groupCover(imagesCover, ["m1", "m2"]),
        title: `Parascene Desktop · ${PROJECT_TITLE} · Images`,
      },
      m1: still("m1"),
      m2: still("m2"),
      solo: still("solo"),
    };

    expect(
      flattenProjectAssetsForBrowserDisplay({
        projectId: PROJECT_ID,
        projectTitle: PROJECT_TITLE,
        rootAssets,
        creationsById,
        projectCabinets: { imagesGroupId: null, videosGroupId: null },
      }).map((row) => row.id),
    ).toEqual(["m1", "m2", "solo"]);
  });

  it("expands every project Images container and never shows their cards", () => {
    const keeper = "images-keeper";
    const extra = "images-extra";
    const rootAssets = [asset(keeper), asset(extra), asset("solo")];
    const creationsById = {
      [keeper]: desktopImagesCover(keeper, ["m1", "m2"]),
      [extra]: desktopImagesCover(extra, ["m2", "m3"]),
      m1: still("m1"),
      m2: still("m2"),
      m3: still("m3"),
      solo: still("solo"),
    };

    expect(
      flattenProjectAssetsForBrowserDisplay({
        projectId: PROJECT_ID,
        projectTitle: PROJECT_TITLE,
        rootAssets,
        creationsById,
        projectCabinets: { imagesGroupId: keeper, videosGroupId: null },
      }).map((row) => row.id),
    ).toEqual(["m1", "m2", "m3", "solo"]);
  });

  it("shows ordinary group covers as tiles", () => {
    const pack = "pack";
    const rootAssets = [asset(pack), asset("p1"), asset("p2"), asset("solo")];
    const creationsById = {
      [pack]: groupCover(pack, ["p1", "p2"]),
      p1: still("p1"),
      p2: still("p2"),
      solo: still("solo"),
    };

    expect(
      flattenProjectAssetsForBrowserDisplay({
        projectId: PROJECT_ID,
        projectTitle: PROJECT_TITLE,
        rootAssets,
        creationsById,
        projectCabinets: { imagesGroupId: null, videosGroupId: null },
      }).map((row) => row.id),
    ).toEqual([pack, "p1", "p2", "solo"]);
  });
});
