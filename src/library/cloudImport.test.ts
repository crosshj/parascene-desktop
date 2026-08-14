import { describe, expect, it } from "vitest";
import {
  cloudHostCaption,
  cloudPlayAction,
  parseCloudImport,
} from "./cloudImport";
import {
  canFetchPlayableMedia,
  isCoverOnlyCloudAv,
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

const sunoJson = JSON.stringify({
  meta: {
    import: {
      provider: "suno",
      url: "https://suno.com/song/abc",
      embed_url: "https://suno.com/embed/abc",
    },
  },
});

const youtubeJson = JSON.stringify({
  meta: {
    import: {
      provider: "youtube",
      kind: "shorts",
      url: "https://www.youtube.com/shorts/xyz",
      embed_url: "https://www.youtube-nocookie.com/embed/xyz?rel=0",
    },
  },
});

describe("parseCloudImport", () => {
  it("reads Suno and YouTube import meta", () => {
    expect(parseCloudImport({ remoteJson: sunoJson })).toEqual({
      provider: "suno",
      label: "Suno",
      pageUrl: "https://suno.com/song/abc",
    });
    expect(parseCloudImport({ remoteJson: youtubeJson })?.provider).toBe(
      "youtube",
    );
    expect(parseCloudImport({ remoteJson: null })).toBeNull();
  });
});

describe("cover-only cloud A/V", () => {
  it("treats Suno cover PNG remotes as uncacheable audio", () => {
    const c = base({
      remoteUrl:
        "https://www.parascene.com/api/images/created/26_x.png?creation_id=1",
      remoteJson: sunoJson,
    });
    expect(canFetchPlayableMedia(c)).toBe(false);
    expect(isCoverOnlyCloudAv(c)).toBe(true);
    expect(cloudHostCaption(c)).toBe("Cloud audio · Suno");
    expect(cloudPlayAction(c)?.label).toBe("Play on Suno");
  });

  it("treats YouTube poster PNGs as cloud video", () => {
    const c = base({
      mediaType: "video",
      localPath: "/Library/media/20678.png",
      remoteUrl: "https://www.parascene.com/api/images/created/26_x.png",
      remoteJson: youtubeJson,
    });
    expect(canFetchPlayableMedia(c)).toBe(false);
    expect(isCoverOnlyCloudAv(c)).toBe(true);
    expect(cloudHostCaption(c)).toBe("Cloud video · YouTube");
  });

  it("still caches real audio remotes", () => {
    const c = base({
      remoteUrl: "https://www.parascene.com/api/audio/created/26_x.mp3",
    });
    expect(canFetchPlayableMedia(c)).toBe(true);
    expect(isCoverOnlyCloudAv(c)).toBe(false);
    expect(cloudHostCaption(c)).toBeNull();
  });
});
