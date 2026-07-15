import { describe, expect, it, vi, beforeEach } from "vitest";
import { mapRemoteCreation, syncCreationsManifest } from "./manifestSync";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../auth/session", () => ({
  ensureAccessToken: vi.fn(async () => "fresh-token"),
  getEnvConfig: () => ({
    baseUrl: "https://www.parascene.com",
    apiBaseUrl: "https://api.parascene.com",
    clientId: "app",
    redirectUri: "http://127.0.0.1:17423/oauth/callback",
    loopbackPort: 17423,
  }),
  createAuthedSdk: () => ({
    listMyCreations: vi.fn(async ({ offset }: { offset: number }) => {
      if (offset > 0) {
        return { images: [], hasMore: false };
      }
      return {
        images: [
          {
            id: 99,
            title: "Sunset",
            filename: "x.png",
            url: "https://cdn.example/x.png",
            thumbnail_url: "/cdn/t.jpg?variant=thumbnail",
            media_type: "image",
            width: 1024,
            height: 576,
            color: "#1a1a1a",
            published: true,
            created_at: "2026-02-01T00:00:00Z",
            meta: { prompt: "golden hour", args: { aspect_ratio: "16:9" } },
          },
        ],
        hasMore: false,
      };
    }),
  }),
}));

describe("manifestSync", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("maps API rows into catalog upserts with full remote snapshot", () => {
    const mapped = mapRemoteCreation({
      id: 7,
      filename: "clip.mp4",
      video_url: "https://cdn.example/clip.mp4",
      thumbnail_url: "https://cdn.example/thumb.jpg",
      media_type: "video",
      width: 1920,
      height: 1080,
      color: "#abcdef",
      published: false,
      published_at: "2026-03-02T00:00:00Z",
      created_at: "2026-03-01T12:00:00Z",
      description: "noir",
      status: "completed",
      meta: { args: { prompt: "noir alley", aspect_ratio: "16:9" } },
    });

    expect(mapped).toMatchObject({
      id: "7",
      title: "clip.mp4",
      mediaType: "video",
      remoteUrl: "https://cdn.example/clip.mp4",
      thumbnailUrl: "https://cdn.example/thumb.jpg",
      videoUrl: "https://cdn.example/clip.mp4",
      published: false,
      publishedAt: "2026-03-02T00:00:00Z",
      createdAt: "2026-03-01T12:00:00Z",
      downloadState: "remote",
      prompt: "noir alley",
      filename: "clip.mp4",
      description: "noir",
      color: "#abcdef",
      status: "completed",
      width: 1920,
      height: 1080,
      aspectRatio: "16:9",
      nsfw: false,
      isModeratedError: false,
    });

    const snap = JSON.parse(mapped.remoteJson) as Record<string, unknown>;
    expect(snap.width).toBe(1920);
    expect(snap.height).toBe(1080);
    expect(snap.video_url).toBe("https://cdn.example/clip.mp4");
    expect(snap.color).toBe("#abcdef");
    expect(snap.meta).toEqual({
      args: { prompt: "noir alley", aspect_ratio: "16:9" },
    });
  });

  it("derives aspectRatio from pixels when meta lacks it", () => {
    const mapped = mapRemoteCreation({
      id: 1,
      url: "https://cdn.example/a.png",
      width: 768,
      height: 1376,
      media_type: "image",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(mapped.aspectRatio).toBe("768:1376");
  });

  it("paginates creations, applies the manifest, then downloads", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "library_apply_manifest") {
        return {
          rootPath: "/tmp",
          lastSyncAt: "2026-07-14T00:00:00Z",
          total: 1,
          local: 0,
          remote: 1,
          queued: 0,
          downloading: 0,
          failed: 0,
          withThumb: 0,
          withMedia: 0,
          missingThumbCacheable: 1,
          missingMediaCacheable: 1,
          mediaBytes: 0,
          thumbsBytes: 0,
          withoutCloudUrls: [],
        };
      }
      if (cmd === "library_download_pending") {
        return {
          downloaded: 1,
          failed: 0,
          skipped: 0,
          status: {
            rootPath: "/tmp",
            lastSyncAt: "2026-07-14T00:00:00Z",
            total: 1,
            local: 1,
            remote: 0,
            queued: 0,
            downloading: 0,
            failed: 0,
            withThumb: 1,
            withMedia: 1,
            missingThumbCacheable: 0,
            missingMediaCacheable: 0,
            mediaBytes: 1024,
            thumbsBytes: 128,
            withoutCloudUrls: [],
          },
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const status = await syncCreationsManifest();
    expect(status.local).toBe(1);
    expect(invoke).toHaveBeenCalledWith(
      "library_apply_manifest",
      expect.objectContaining({
        creations: [
          expect.objectContaining({
            id: "99",
            title: "Sunset",
            prompt: "golden hour",
            width: 1024,
            height: 576,
            aspectRatio: "16:9",
            color: "#1a1a1a",
            thumbnailUrl: "https://www.parascene.com/cdn/t.jpg?variant=thumbnail",
            remoteJson: expect.stringContaining("\"width\":1024"),
          }),
        ],
      }),
    );
    expect(invoke).toHaveBeenCalledWith("library_download_pending", {
      limit: 40,
    });
  });
});
