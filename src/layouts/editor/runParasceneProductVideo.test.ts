import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../library/catalogClient", () => ({
  getCreations: vi.fn(),
}));

vi.mock("../../lab/audioTools", () => ({
  uploadLocalImageFile: vi.fn(),
}));

vi.mock("./timelineReferenceImages", () => ({
  resolveReferenceImageStill: vi.fn(),
}));

vi.mock("./resolveLocalMedia", () => ({
  resolveLocalMediaPath: vi.fn(),
}));

vi.mock("./addAssetStartFrame", async () => {
  const actual = await vi.importActual<typeof import("./addAssetStartFrame")>(
    "./addAssetStartFrame",
  );
  return {
    ...actual,
    resolveParasceneStartFrameImageUrl: vi.fn(),
  };
});

import { getCreations } from "../../library/catalogClient";
import { uploadLocalImageFile } from "../../lab/audioTools";
import { resolveReferenceImageStill } from "./timelineReferenceImages";
import { resolveLocalMediaPath } from "./resolveLocalMedia";
import { resolveParasceneStartFrameImageUrl } from "./addAssetStartFrame";
import { resolveParasceneReferenceImageUrl } from "./runParasceneProductVideo";
import type { TimelineClip } from "../../project/types";

const getCreationsMock = vi.mocked(getCreations);
const uploadMock = vi.mocked(uploadLocalImageFile);
const stillMock = vi.mocked(resolveReferenceImageStill);
const localPathMock = vi.mocked(resolveLocalMediaPath);
const hostedUrlMock = vi.mocked(resolveParasceneStartFrameImageUrl);

const placeholder: TimelineClip = {
  id: "ph-1",
  label: "0:05",
  startSec: 0,
  endSec: 5,
  lane: "video",
  kind: "video",
  isAddAssetPlaceholder: true,
};

describe("resolveParasceneReferenceImageUrl", () => {
  beforeEach(() => {
    getCreationsMock.mockReset();
    uploadMock.mockReset();
    stillMock.mockReset();
    localPathMock.mockReset();
    hostedUrlMock.mockReset();
  });

  it("uses a public Parascene URL when the asset is already hosted", async () => {
    getCreationsMock.mockResolvedValue([
      {
        id: "c-1",
        mediaType: "image",
        remoteUrl: "https://cdn.example/cafe.jpg",
      } as never,
    ]);
    await expect(
      resolveParasceneReferenceImageUrl({
        id: "c-1",
        timeline: [placeholder],
        placeholder,
        aspectRatio: "16:9",
      }),
    ).resolves.toBe("https://cdn.example/cafe.jpg");
    expect(stillMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uploads a local-only project image so Parascene can fetch it", async () => {
    getCreationsMock.mockResolvedValue([
      {
        id: "local-1738927958597-2212-9",
        mediaType: "image",
        localPath: "/tmp/cafe.jpg",
      } as never,
    ]);
    localPathMock.mockResolvedValue("/tmp/cafe.jpg");
    uploadMock.mockResolvedValue({ url: "https://cdn.example/ephemeral.jpg" });
    await expect(
      resolveParasceneReferenceImageUrl({
        id: "local-1738927958597-2212-9",
        timeline: [placeholder],
        placeholder,
        aspectRatio: "16:9",
      }),
    ).resolves.toBe("https://cdn.example/ephemeral.jpg");
    expect(stillMock).not.toHaveBeenCalled();
    expect(uploadMock).toHaveBeenCalledWith(
      "/tmp/cafe.jpg",
      expect.objectContaining({ filename: "parascene-ref.jpg" }),
    );
  });
});
