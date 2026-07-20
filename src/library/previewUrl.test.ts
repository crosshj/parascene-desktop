import { describe, expect, it } from "vitest";
import {
  canFetchLocal,
  hasLocalMedia,
  isParasceneUnavailable,
  withPreviewCacheBust,
} from "./previewUrl";
import type { Creation } from "./types";

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
