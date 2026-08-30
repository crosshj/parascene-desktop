import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  isCreatingRemoteStatus,
  mapGroupSourceCreations,
  mapRemoteCreation,
  NEWEST_SYNC_MAX_PAGES,
  NEWEST_SYNC_PAGE_SIZE,
  recentPruneSinceIso,
  remoteFromGroupSource,
  syncCreationsManifest,
  syncFullCreationsManifest,
  syncGroupMembersManifest,
  syncNewestCreationsManifest,
  withEmbeddedGroupMembers,
} from "./manifestSync";

const invoke = vi.fn();
const runSyncFull = vi.fn();
const runSyncNewest = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("../services/syncCatalog", () => ({
  runSyncFull: (...args: unknown[]) => runSyncFull(...args),
  runSyncNewest: (...args: unknown[]) => runSyncNewest(...args),
  refreshCreationsFromListById: vi.fn(),
}));

vi.mock("../auth/session", () => ({
  getEnvConfig: () => ({
    baseUrl: "https://www.parascene.com",
    apiBaseUrl: "https://api.parascene.com",
    clientId: "app",
    redirectUri: "http://127.0.0.1:17423/oauth/callback",
    loopbackPort: 17423,
  }),
  ensureAccessToken: vi.fn(async () => "access-jwt"),
  getMemorySession: vi.fn(() => null),
}));

const emptyStatus = {
  rootPath: "/tmp",
  lastSyncAt: "2026-07-14T00:00:00Z",
  total: 0,
  local: 0,
  remote: 0,
  queued: 0,
  downloading: 0,
  failed: 0,
  withThumb: 0,
  withMedia: 0,
  missingThumbCacheable: 0,
  missingMediaCacheable: 0,
  missingThumbUncacheable: 0,
  missingMediaUncacheable: 0,
  mediaBytes: 0,
  thumbsBytes: 0,
  withoutCloudUrls: [],
};

function remoteImage(id: number | string, title = `Creation ${id}`) {
  return {
    id,
    title,
    filename: `${id}.png`,
    url: `https://cdn.example/${id}.png`,
    thumbnail_url: `/cdn/${id}.jpg?variant=thumbnail`,
    media_type: "image",
    width: 1024,
    height: 576,
    color: "#1a1a1a",
    published: true,
    created_at: "2026-02-01T00:00:00Z",
    meta: { prompt: "golden hour", args: { aspect_ratio: "16:9" } },
  };
}

function mockDownloadPending() {
  invoke.mockImplementation(async (cmd: string, args?: { ids?: string[]; creations?: unknown[] }) => {
    if (cmd === "library_existing_creation_ids") {
      return [];
    }
    if (cmd === "library_apply_manifest") {
      return {
        ...emptyStatus,
        total: Array.isArray(args?.creations) ? args.creations.length : 0,
        remote: Array.isArray(args?.creations) ? args.creations.length : 0,
      };
    }
    if (cmd === "library_download_pending") {
      return {
        downloaded: 1,
        failed: 0,
        skipped: 0,
        status: { ...emptyStatus, local: 1, total: 1 },
      };
    }
    if (cmd === "library_cloud_ids_since") {
      return [];
    }
    if (cmd === "library_delete_local") {
      return emptyStatus;
    }
    if (cmd === "library_sync_status") {
      return emptyStatus;
    }
    if (cmd === "library_list_creations") {
      return [];
    }
    if (cmd === "library_get_creations") {
      return [];
    }
    if (cmd === "auth_ensure_user_avatar") {
      return { ok: true, localPath: null, reason: "No avatar URL" };
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

describe("manifestSync", () => {
  beforeEach(() => {
    invoke.mockReset();
    runSyncFull.mockReset();
    runSyncNewest.mockReset();
    runSyncFull.mockResolvedValue({
      status: { ...emptyStatus, total: 1, remote: 1 },
      added: 1,
      checked: 1,
      pages: 1,
      message: "Done",
    });
    runSyncNewest.mockResolvedValue({
      status: { ...emptyStatus, total: 1, remote: 1 },
      added: 1,
      pruned: 0,
      checked: 1,
      target: NEWEST_SYNC_PAGE_SIZE * NEWEST_SYNC_MAX_PAGES,
      message: "Done",
    });
    mockDownloadPending();
  });

  it("derives fit_thumbnail_url from square thumbnail when API omits it", () => {
    const mapped = mapRemoteCreation({
      id: 18843,
      filename: "clip.png",
      video_url: "https://cdn.example/clip.mp4",
      thumbnail_url:
        "https://www.parascene.com/api/images/created/x.png?creation_id=18843&variant=thumbnail",
      media_type: "video",
      width: 576,
      height: 1024,
      created_at: "2026-07-20T00:00:00Z",
    });
    expect(mapped.fitThumbnailUrl).toBe(
      "https://www.parascene.com/api/images/created/x.png?creation_id=18843&variant=fit",
    );
  });

  it("maps CDN audio Creations to audio_url as remoteUrl (cover stays on url/thumbs)", () => {
    const mapped = mapRemoteCreation({
      id: 27140,
      filename: "cover.png",
      title: "Dichotomy (blegh)",
      url: "https://www.parascene.com/api/images/created/cover.png",
      thumbnail_url:
        "https://www.parascene.com/api/images/created/cover.png?variant=thumbnail",
      audio_url: "/api/create/images/27140/audio",
      media_type: "audio",
      created_at: "2026-08-30T08:23:53Z",
      meta: {
        audio: {
          cdn_id: "o_8972e00517b91de76c0d3c64",
          duration: 314.24,
          content_type: "audio/mpeg",
          filename: "Dichotomy (blegh).mp3",
        },
      },
    });

    expect(mapped).toMatchObject({
      id: "27140",
      mediaType: "audio",
      remoteUrl: "https://www.parascene.com/api/create/images/27140/audio",
      thumbnailUrl:
        "https://www.parascene.com/api/images/created/cover.png?variant=thumbnail",
    });
    const snap = JSON.parse(mapped.remoteJson);
    expect(snap.audio_url).toBe(
      "https://www.parascene.com/api/create/images/27140/audio",
    );
    expect(snap.url).toBe(
      "https://www.parascene.com/api/images/created/cover.png",
    );
  });

  it("keeps cover-only audio remoteUrl as image when audio_url is missing", () => {
    const mapped = mapRemoteCreation({
      id: 99,
      url: "https://cdn.example/suno-cover.png",
      thumbnail_url: "https://cdn.example/suno-cover.png?variant=thumbnail",
      media_type: "audio",
      created_at: "2026-08-01T00:00:00Z",
      meta: { import: { provider: "suno", url: "https://suno.com/song/x" } },
    });
    expect(mapped.remoteUrl).toBe("https://cdn.example/suno-cover.png");
    expect(JSON.parse(mapped.remoteJson).audio_url).toBeNull();
  });

  it("maps API rows into catalog upserts with full remote snapshot", () => {
    const mapped = mapRemoteCreation({
      id: 7,
      filename: "clip.mp4",
      video_url: "https://cdn.example/clip.mp4",
      thumbnail_url: "https://cdn.example/thumb.jpg",
      fit_thumbnail_url: "https://cdn.example/thumb.jpg?variant=fit",
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
      fitThumbnailUrl: "https://cdn.example/thumb.jpg?variant=fit",
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

    const snap = JSON.parse(mapped.remoteJson);
    expect(snap).toMatchObject({
      id: "7",
      url: null,
      video_url: "https://cdn.example/clip.mp4",
      fit_thumbnail_url: "https://cdn.example/thumb.jpg?variant=fit",
      media_type: "video",
      width: 1920,
      height: 1080,
    });
  });

  it("detects creating remote status including prefixed variants", () => {
    expect(isCreatingRemoteStatus("creating")).toBe(true);
    expect(isCreatingRemoteStatus("Creating")).toBe(true);
    expect(isCreatingRemoteStatus("creating_video")).toBe(true);
    expect(isCreatingRemoteStatus("pending")).toBe(false);
    expect(isCreatingRemoteStatus("completed")).toBe(false);
    expect(isCreatingRemoteStatus(null)).toBe(false);
  });

  it("derives video_url for embedded i2v members that only have a poster path", () => {
    const remote = remoteFromGroupSource({
      id: 18843,
      file_path: "/api/images/created/26_18843_1784522709211_7in916e.png",
      filename: "26_18843_1784522709211_7in916e.png",
      meta: { media_type: "video" },
    });
    expect(remote).toMatchObject({
      id: "18843",
      media_type: "video",
      video_url: "/api/videos/created/video/26_18843_1784522709211_7in916e.mp4",
    });
  });

  it("maps embedded group source creations and absolutizes file_path", () => {
    const remote = remoteFromGroupSource({
      id: 17804,
      file_path: "/api/images/created/26_17804_x.png",
      media_type: "image",
      meta: { prompt: "member" },
    });
    expect(remote).toMatchObject({
      id: "17804",
      url: "/api/images/created/26_17804_x.png",
      thumbnail_url: "/api/images/created/26_17804_x.png?variant=thumbnail",
      media_type: "image",
    });
    const mapped = mapGroupSourceCreations([
      {
        id: 17804,
        file_path: "/api/images/created/26_17804_x.png",
        media_type: "image",
      },
    ]);
    expect(mapped[0]?.remoteUrl).toBe(
      "https://www.parascene.com/api/images/created/26_17804_x.png",
    );
  });

  it("mapGroupSourceCreations skips members still in creating status", () => {
    const mapped = mapGroupSourceCreations([
      {
        id: 1,
        file_path: "/api/images/created/ready.png",
        media_type: "image",
        status: "completed",
      },
      {
        id: 2,
        file_path: "/api/images/created/wip.png",
        media_type: "image",
        status: "creating",
      },
    ]);
    expect(mapped.map((c) => c.id)).toEqual(["1"]);
  });

  it("withEmbeddedGroupMembers appends missing members without duplicating", () => {
    const coverUpsert = mapRemoteCreation({
      id: 17805,
      filename: "group/cover.json",
      url: "https://cdn.example/cover.png",
      media_type: "image",
      created_at: "2026-02-01T00:00:00Z",
      meta: {
        group: {
          kind: "group_creations",
          source_creations: [
            {
              id: 17804,
              file_path: "/api/images/created/26_17804_x.png",
              media_type: "image",
            },
          ],
        },
      },
    });
    const existingMember = mapRemoteCreation(remoteImage(17804, "Already local"));
    const expanded = withEmbeddedGroupMembers([existingMember, coverUpsert]);
    const ids = expanded.map((c) => c.id);
    expect(ids.filter((id) => id === "17804")).toHaveLength(1);
    expect(ids).toContain("17805");
    expect(expanded.find((c) => c.id === "17804")?.title).toBe("Already local");
  });

  it("syncGroupMembersManifest upserts missing embedded members from local covers", async () => {
    const cover = mapRemoteCreation({
      id: 200,
      filename: "group/cover.json",
      url: "https://cdn.example/cover.png",
      media_type: "image",
      created_at: "2026-02-01T00:00:00Z",
      meta: {
        group: {
          kind: "group_creations",
          source_creations: [
            {
              id: 201,
              file_path: "/api/images/created/26_201_x.png",
              media_type: "image",
            },
            {
              id: 202,
              file_path: "/api/images/created/26_202_x.png",
              media_type: "image",
            },
          ],
        },
      },
    });
    invoke.mockImplementation(async (cmd: string, args?: { creations?: unknown[] }) => {
      if (cmd === "library_list_creations") {
        return [
          {
            id: cover.id,
            title: cover.title,
            mediaType: cover.mediaType,
            remoteUrl: cover.remoteUrl,
            thumbnailUrl: cover.thumbnailUrl,
            fitThumbnailUrl: cover.fitThumbnailUrl,
            videoUrl: cover.videoUrl,
            localPath: null,
            localThumbPath: null,
            published: false,
            publishedAt: null,
            createdAt: cover.createdAt,
            syncedAt: cover.createdAt,
            downloadState: "remote",
            prompt: null,
            filename: cover.filename,
            description: null,
            color: null,
            status: "completed",
            width: null,
            height: null,
            aspectRatio: null,
            nsfw: false,
            isModeratedError: false,
            remoteJson: cover.remoteJson,
          },
        ];
      }
      if (cmd === "library_apply_manifest") {
        return {
          ...emptyStatus,
          total: 1 + (Array.isArray(args?.creations) ? args.creations.length : 0),
          remote: 1 + (Array.isArray(args?.creations) ? args.creations.length : 0),
        };
      }
      if (cmd === "library_download_pending") {
        return {
          downloaded: 0,
          failed: 0,
          skipped: 0,
          status: emptyStatus,
        };
      }
      if (cmd === "library_sync_status") {
        return emptyStatus;
      }
      if (cmd === "library_get_creations") {
        return [];
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await syncGroupMembersManifest();
    expect(result.groups).toBe(1);
    expect(result.added).toBe(2);
    expect(invoke).toHaveBeenCalledWith(
      "library_apply_manifest",
      expect.objectContaining({
        creations: expect.arrayContaining([
          expect.objectContaining({ id: "201" }),
          expect.objectContaining({ id: "202" }),
        ]),
      }),
    );
  });

  it("full sync delegates to runSyncFull", async () => {
    const status = await syncFullCreationsManifest();
    expect(status.total).toBe(1);
    expect(status.remote).toBe(1);
    expect(runSyncFull).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "library_download_pending",
      expect.any(Object),
    );
  });

  it("syncCreationsManifest aliases full sync", async () => {
    await syncCreationsManifest();
    expect(runSyncFull).toHaveBeenCalledTimes(1);
  });

  it("newest sync delegates to runSyncNewest", async () => {
    const result = await syncNewestCreationsManifest();
    expect(result.added).toBe(1);
    expect(result.pruned).toBe(0);
    expect(runSyncNewest).toHaveBeenCalledTimes(1);
  });

  it("recentPruneSinceIso never looks further back than a few hours", () => {
    const now = Date.parse("2026-07-19T18:00:00.000Z");
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * 1000).toISOString();
    const dayAgo = "2026-07-18T18:00:00.000Z";
    expect(recentPruneSinceIso(dayAgo, now)).toBe(sixHoursAgo);
    expect(recentPruneSinceIso("2026-07-19T17:00:00.000Z", now)).toBe(
      "2026-07-19T17:00:00.000Z",
    );
  });
});
