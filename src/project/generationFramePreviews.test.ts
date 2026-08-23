import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Creation } from "../library/types";
import type { AddAssetGeneration } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol?: string) =>
    protocol ? `${protocol}://${path}` : `asset://${path}`,
}));

vi.mock("../library/catalogClient", () => ({
  getCreations: vi.fn(),
}));

import { getCreations } from "../library/catalogClient";
import {
  loadGenerationFramePreviews,
  matchCreationIdByRemoteUrl,
  resolveGenerationFramePreviews,
} from "./generationFramePreviews";

const getCreationsMock = vi.mocked(getCreations);

function baseCreation(
  id: string,
  opts: { localThumbPath?: string | null } = {},
): Creation {
  return {
    id,
    title: id,
    mediaType: "image",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: opts.localThumbPath ?? null,
    published: false,
    publishedAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    downloadState: opts.localThumbPath ? "local" : "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-08-23T00:00:00.000Z",
    filename: null,
    description: null,
    color: null,
    status: "completed",
    width: 512,
    height: 512,
    aspectRatio: "1:1",
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
  };
}

describe("resolveGenerationFramePreviews", () => {
  it("prefers stamped preview URLs over asset ids", () => {
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "out-1",
      mode: "start_frame",
      startFrameAssetId: "still-1",
      startFramePreviewUrl: "https://example.com/stamp-start.png",
      endFramePreviewUrl: "https://example.com/stamp-end.png",
      lastFrameSource: { kind: "asset", assetId: "still-2" },
    };
    const resolved = resolveGenerationFramePreviews(generation, {
      "still-1": baseCreation("still-1", {
        localThumbPath: "/tmp/catalog-start.png",
      }),
      "still-2": baseCreation("still-2", {
        localThumbPath: "/tmp/catalog-end.png",
      }),
    });
    expect(resolved).toEqual({
      startAssetId: "still-1",
      endAssetId: "still-2",
      startPreviewUrl: "https://example.com/stamp-start.png",
      endPreviewUrl: "https://example.com/stamp-end.png",
    });
  });

  it("falls back to asset id + in-memory Creation preview", () => {
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "out-1",
      mode: "start_frame",
      startFrameAssetId: "still-1",
      firstFrameSource: { kind: "asset", assetId: "still-1" },
    };
    const resolved = resolveGenerationFramePreviews(generation, {
      "still-1": baseCreation("still-1", {
        localThumbPath: "/tmp/from-catalog.png",
      }),
    });
    expect(resolved.startAssetId).toBe("still-1");
    expect(resolved.startPreviewUrl).toMatch(/^asset:\/\/\/tmp\/from-catalog\.png/);
  });

  it("exposes asset id with null URL when Creation is not in hand", () => {
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "out-1",
      mode: "start_frame",
      startFrameAssetId: "still-1",
    };
    const resolved = resolveGenerationFramePreviews(generation);
    expect(resolved).toEqual({
      startAssetId: "still-1",
      endAssetId: null,
      startPreviewUrl: null,
      endPreviewUrl: null,
    });
  });

  it("ignores local-* FIRST and matches Creation id from stamped input URL", () => {
    const still = baseCreation("25802", {
      localThumbPath: "/tmp/still.png",
    });
    still.remoteUrl = "https://sh.parascene.com/api/share/v1/still/image";
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "vid-1",
      mode: "start_frame",
      startFrameAssetId: "local-temp-extract",
      firstFrameSource: { kind: "asset", assetId: "local-temp-extract" },
      startFramePreviewUrl: "https://sh.parascene.com/api/share/v1/still/image",
    };
    const resolved = resolveGenerationFramePreviews(generation, {
      "25802": still,
    });
    expect(resolved.startAssetId).toBe("25802");
    expect(resolved.startPreviewUrl).toBe(
      "https://sh.parascene.com/api/share/v1/still/image",
    );
  });

  it("matchCreationIdByRemoteUrl normalizes trailing slash and query", () => {
    const still = baseCreation("99");
    still.remoteUrl = "https://cdn.example/a.png";
    expect(
      matchCreationIdByRemoteUrl("https://cdn.example/a.png?x=1", [still]),
    ).toBe("99");
    expect(
      matchCreationIdByRemoteUrl("https://cdn.example/a.png/", {
        "99": still,
      }),
    ).toBe("99");
    expect(matchCreationIdByRemoteUrl("https://other/x.png", [still])).toBeNull();
  });

});

describe("loadGenerationFramePreviews", () => {
  beforeEach(() => {
    getCreationsMock.mockReset();
  });

  it("fetches catalog rows for missing preview URLs (locked Form path)", async () => {
    getCreationsMock.mockResolvedValue([
      baseCreation("still-1", {
        localThumbPath: "/tmp/loaded.png",
      }),
    ]);
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "out-1",
      mode: "start_frame",
      startFrameAssetId: "still-1",
    };
    const loaded = await loadGenerationFramePreviews(generation);
    expect(getCreationsMock).toHaveBeenCalledWith(["still-1"]);
    expect(loaded.startPreviewUrl).toMatch(/^asset:\/\/\/tmp\/loaded\.png/);
    expect(loaded.startAssetId).toBe("still-1");
  });

  it("skips catalog hop when stamp URL already exists", async () => {
    const generation: AddAssetGeneration = {
      prompt: "x",
      generatedAt: "2026-08-23T00:00:00.000Z",
      creationId: "out-1",
      mode: "start_frame",
      startFrameAssetId: "still-1",
      startFramePreviewUrl: "https://example.com/stamp.png",
    };
    const loaded = await loadGenerationFramePreviews(generation);
    expect(getCreationsMock).not.toHaveBeenCalled();
    expect(loaded.startPreviewUrl).toBe("https://example.com/stamp.png");
  });
});
