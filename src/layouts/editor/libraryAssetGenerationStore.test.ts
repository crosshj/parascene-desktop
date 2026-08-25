import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Creation } from "../../library/types";
import type { LibraryAssetPlaceholder } from "../../project/libraryAssetPlaceholder";
import type { ParasceneStillModelOption } from "./parasceneProductCaps";
import {
  bindLibraryAssetGenerationApplier,
  retryLibraryAssetPlaceholder,
  startLibraryParasceneImageToImage,
  waitForCatalogLocalMedia,
} from "./libraryAssetGenerationStore";

const getCreation = vi.fn();

vi.mock("../../library/catalogClient", () => ({
  applyManifest: vi.fn(),
  getCreation: (...args: unknown[]) => getCreation(...args),
}));

vi.mock("./runParasceneImageToImage", () => ({
  runParasceneImageToImage: vi.fn(async () => ({
    creationId: "remote-99",
    projectCreationIds: [],
    imagesGroupId: null,
  })),
}));

const blueRoute: ParasceneStillModelOption = {
  id: "6:image2image:qga10b_qgo10b",
  label: "qga10b_qgo10b",
  value: "qga10b_qgo10b",
  serverId: 6,
  method: "image2image",
  family: "blue",
  supportsInputImages: true,
};

vi.mock("./parasceneProductCaps", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./parasceneProductCaps")>();
  return {
    ...actual,
    parasceneResolveStillModel: () => blueRoute,
    parasceneStillModelFamilies: () => [
      {
        family: "blue",
        label: "Blue",
        models: [blueRoute],
      },
    ],
  };
});

function failedPlaceholder(
  patch: Partial<LibraryAssetPlaceholder> = {},
): LibraryAssetPlaceholder {
  return {
    id: "placeholder-retry",
    kind: "image",
    aspectRatio: "16:9",
    status: "error",
    addAssetDraft: {
      prompt: "make it blue",
      intentId: "image_to_image",
      server: "parascene_blue",
      provider: "parascene_blue",
      methodId: "image_to_image",
      replicateModel: blueRoute.value,
      startFrameAssetId: "source-1",
      lastError: "fetch failed",
    },
    progressNote: "fetch failed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...patch,
  };
}

describe("retryLibraryAssetPlaceholder", () => {
  beforeEach(() => {
    getCreation.mockReset();
    getCreation.mockResolvedValue({
      id: "remote-99",
      localPath: "/tmp/remote-99.png",
      localThumbPath: "/tmp/remote-99.jpg",
    } as Creation);
    bindLibraryAssetGenerationApplier({
      beginPlaceholder: vi.fn(),
      onGenerationStarted: vi.fn(),
      patchPlaceholder: vi.fn(),
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });
  });

  it("restarts image-to-image on the same placeholder id", async () => {
    const id = await retryLibraryAssetPlaceholder({
      placeholder: failedPlaceholder(),
      projectId: "project-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
    });
    expect(id).toBe("placeholder-retry");
  });

  it("passes placeholderId through to startLibraryParasceneImageToImage", () => {
    const beginPlaceholder = vi.fn();
    bindLibraryAssetGenerationApplier({
      beginPlaceholder,
      onGenerationStarted: vi.fn(),
      patchPlaceholder: vi.fn(),
      completePlaceholder: vi.fn(),
      addCreations: vi.fn(async () => {}),
      setImagesGroupId: vi.fn(),
    });

    startLibraryParasceneImageToImage({
      projectId: "project-1",
      projectTitle: "Demo",
      imagesGroupId: null,
      videosGroupId: null,
      aspectRatio: "16:9",
      prompt: "test",
      modelId: blueRoute.id,
      route: blueRoute,
      sourceCreationId: "source-1",
      placeholderId: "placeholder-retry",
    });

    expect(beginPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({ id: "placeholder-retry" }),
    );
  });
});

describe("waitForCatalogLocalMedia", () => {
  beforeEach(() => {
    getCreation.mockReset();
  });

  it("returns true once the catalog row has local files", async () => {
    getCreation
      .mockRejectedValueOnce(new Error("not found"))
      .mockResolvedValueOnce({
        id: "26053",
        localPath: null,
        localThumbPath: null,
      } as Creation)
      .mockResolvedValueOnce({
        id: "26053",
        localPath: "/tmp/26053.png",
        localThumbPath: "/tmp/26053.jpg",
      } as Creation);

    await expect(
      waitForCatalogLocalMedia("26053", { timeoutMs: 1_000, pollMs: 10 }),
    ).resolves.toBe(true);
  });

  it("returns false when files never land", async () => {
    getCreation.mockResolvedValue({
      id: "26053",
      localPath: null,
      localThumbPath: null,
    } as Creation);

    await expect(
      waitForCatalogLocalMedia("26053", { timeoutMs: 40, pollMs: 10 }),
    ).resolves.toBe(false);
  });
});
