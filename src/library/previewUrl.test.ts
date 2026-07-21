import { describe, expect, it, vi } from "vitest";
import {
  canFetchLocal,
  creationDetailUrl,
  hasLocalMedia,
  isParasceneUnavailable,
  withPreviewCacheBust,
} from "./previewUrl";
import type { Creation } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol?: string) =>
    protocol ? `${protocol}://${path}` : `asset://${path}`,
}));

function base(overrides: Partial<Creation> = {}): Creation {
  return {
    id: "c1",
    title: "Track",
    mediaType: "audio",
    remoteUrl: null,
    thumbnailUrl: null,
    fitThumbnailUrl: null,
    videoUrl: null,
    localPath: null,
    localThumbPath: null,
    published: false,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    downloadState: "remote",
    checksum: null,
    prompt: null,
    expiresAt: null,
    updatedAt: "2026-01-01T00:00:00Z",
    filename: "track.mp3",
    description: null,
    color: null,
    status: null,
    width: null,
    height: null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: null,
    ...overrides,
  };
}

describe("withPreviewCacheBust", () => {
  it("appends updatedAt so rewritten files remount", () => {
    expect(withPreviewCacheBust("asset://thumb.jpg", "2026-07-20T01:00:00Z")).toBe(
      "asset://thumb.jpg?v=2026-07-20T01%3A00%3A00Z",
    );
    expect(
      withPreviewCacheBust("asset://thumb.jpg?x=1", "2026-07-20T01:00:00Z"),
    ).toBe("asset://thumb.jpg?x=1&v=2026-07-20T01%3A00%3A00Z");
  });

  it("leaves src unchanged when version is empty", () => {
    expect(withPreviewCacheBust("asset://thumb.jpg", "")).toBe("asset://thumb.jpg");
    expect(withPreviewCacheBust("asset://thumb.jpg", null)).toBe("asset://thumb.jpg");
  });
});

describe("creationDetailUrl", () => {
  it("serves video and audio over the Range-capable media scheme", () => {
    const video = creationDetailUrl(
      base({
        mediaType: "video",
        localPath: "/Movies/Parascene/Library/media/1.mp4",
        updatedAt: "t1",
      }),
    );
    expect(video).toMatch(/^media:\/\//);
    expect(video).toContain("1.mp4");

    const audio = creationDetailUrl(
      base({
        mediaType: "audio",
        localPath: "/Movies/Parascene/Library/media/a.mp3",
        updatedAt: "t1",
      }),
    );
    expect(audio).toMatch(/^media:\/\//);
  });

  it("keeps images on the asset scheme", () => {
    const image = creationDetailUrl(
      base({
        mediaType: "image",
        localPath: "/Movies/Parascene/Library/media/1.png",
        updatedAt: "t1",
      }),
    );
    expect(image).toMatch(/^asset:\/\//);
  });
});

describe("isParasceneUnavailable", () => {
  it("treats disk-only imports with localPath as available", () => {
    const c = base({
      downloadState: "local",
      status: "local",
      localPath: "/Library/media/local-1_track.mp3",
    });
    expect(canFetchLocal(c)).toBe(false);
    expect(hasLocalMedia(c)).toBe(true);
    expect(isParasceneUnavailable(c)).toBe(false);
  });

  it("still flags moderated / failed cloud rows", () => {
    expect(
      isParasceneUnavailable(
        base({
          isModeratedError: true,
          remoteUrl: "https://x",
          localPath: "/tmp/a.mp3",
        }),
      ),
    ).toBe(true);
    expect(
      isParasceneUnavailable(base({ status: "failed", remoteUrl: null })),
    ).toBe(true);
  });

  it("flags remote rows with no assets and no local files", () => {
    expect(isParasceneUnavailable(base())).toBe(true);
  });
});
