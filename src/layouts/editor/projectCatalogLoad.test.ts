import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Creation } from "../../library/types";
import type { ProjectAsset } from "../../project/types";

const getCreations = vi.fn();
const applyManifest = vi.fn();
const getRemoteCreation = vi.fn();

vi.mock("../../library/catalogClient", () => ({
  getCreations: (...args: unknown[]) => getCreations(...args),
  applyManifest: (...args: unknown[]) => applyManifest(...args),
}));

vi.mock("../../services/parasceneCatalog", () => ({
  getRemoteCreation: (...args: unknown[]) => getRemoteCreation(...args),
}));

import { loadProjectAssetsCatalog } from "./projectCatalogLoad";

const PROJECT_ID = "project-1";
const PROJECT_TITLE = "The More I Know";

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
    localPath: partial.localPath ?? "/tmp/Movies/Parascene/media/x.png",
    localThumbPath: partial.localThumbPath ?? "/tmp/Movies/Parascene/thumbs/x.png",
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadState: "local",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    filename: `${partial.id}.png`,
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

function asset(id: string): ProjectAsset {
  return { id, name: id, kind: "image" };
}

describe("loadProjectAssetsCatalog", () => {
  beforeEach(() => {
    getCreations.mockReset();
    applyManifest.mockReset();
    getRemoteCreation.mockReset();
  });

  it("reads the local catalog and never calls Parascene", async () => {
    const cover = stubCreation({
      id: "images-cabinet",
      filename: "group/images-cabinet.png",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: ["m1"],
            source_creations: [{ id: "m1", url: "https://www.parascene.com/m1.png" }],
          },
        },
      }),
    });
    const member = stubCreation({ id: "m1" });
    getCreations.mockImplementation(async (ids: string[]) => {
      const byId: Record<string, Creation> = {
        [cover.id]: cover,
        [member.id]: member,
      };
      return ids.map((id) => byId[id]).filter(Boolean);
    });

    const next = await loadProjectAssetsCatalog({
      rootAssetIds: [cover.id],
      projectId: PROJECT_ID,
      projectTitle: PROJECT_TITLE,
      rootAssets: [asset(cover.id)],
      creationsById: {},
      projectCabinets: { imagesGroupId: cover.id, videosGroupId: null },
    });

    expect(next[cover.id]?.id).toBe(cover.id);
    expect(next.m1?.id).toBe("m1");
    expect(getRemoteCreation).not.toHaveBeenCalled();
    expect(applyManifest).not.toHaveBeenCalled();
  });

  it("materializes missing members from local cover JSON, not Parascene", async () => {
    const cover = stubCreation({
      id: "images-cabinet",
      filename: "group/images-cabinet.png",
      remoteJson: JSON.stringify({
        meta: {
          group: {
            kind: "group_creations",
            source_creation_ids: ["m1"],
            source_creations: [
              {
                id: "m1",
                url: "https://www.parascene.com/m1.png",
                media_type: "image",
                status: "complete",
              },
            ],
          },
        },
      }),
    });
    getCreations
      .mockResolvedValueOnce([cover])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([stubCreation({ id: "m1" })]);
    applyManifest.mockResolvedValue({});

    const next = await loadProjectAssetsCatalog({
      rootAssetIds: [cover.id],
      projectId: PROJECT_ID,
      projectTitle: PROJECT_TITLE,
      rootAssets: [asset(cover.id)],
      creationsById: {},
      projectCabinets: { imagesGroupId: cover.id, videosGroupId: null },
    });

    expect(applyManifest).toHaveBeenCalled();
    expect(next.m1?.id).toBe("m1");
    expect(getRemoteCreation).not.toHaveBeenCalled();
  });
});
