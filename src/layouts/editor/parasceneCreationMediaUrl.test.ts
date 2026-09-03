import { describe, expect, it } from "vitest";
import {
  resolveParasceneVideoRefUrl,
  withParasceneCreationId,
} from "./parasceneCreationMediaUrl";
import type { Creation } from "../../library/types";

function row(
  overrides: Partial<Creation> & Pick<Creation, "id">,
): Creation {
  return {
    title: "Clip",
    mediaType: "video",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    downloadState: "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    filename: null,
    description: null,
    color: null,
    status: "completed",
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
    ...overrides,
  };
}

describe("withParasceneCreationId", () => {
  it("stamps creation_id on hosted video URLs", () => {
    expect(
      withParasceneCreationId(
        "https://www.parascene.com/api/videos/created/video/26_27644_x.mp4",
        "27644",
      ),
    ).toBe(
      "https://www.parascene.com/api/videos/created/video/26_27644_x.mp4?creation_id=27644",
    );
  });

  it("leaves already-stamped URLs alone", () => {
    const url =
      "https://www.parascene.com/api/videos/created/video/26_27644_x.mp4?creation_id=27644";
    expect(withParasceneCreationId(url, "27644")).toBe(url);
  });
});

describe("resolveParasceneVideoRefUrl", () => {
  it("prefers videoUrl over a poster remoteUrl", () => {
    expect(
      resolveParasceneVideoRefUrl(
        row({
          id: "27644",
          remoteUrl:
            "https://www.parascene.com/api/images/created/26_27644.png",
          videoUrl:
            "https://www.parascene.com/api/videos/created/video/26_27644_1788399457200_8qcahtr.mp4",
        }),
      ),
    ).toBe(
      "https://www.parascene.com/api/videos/created/video/26_27644_1788399457200_8qcahtr.mp4?creation_id=27644",
    );
  });

  it("rejects poster-only rows", () => {
    expect(() =>
      resolveParasceneVideoRefUrl(
        row({
          id: "27644",
          remoteUrl:
            "https://www.parascene.com/api/images/created/26_27644.png",
        }),
      ),
    ).toThrow(/no Parascene video URL/);
  });
});
