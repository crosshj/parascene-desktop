import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  mapGroupSourceCreations,
  mapRemoteCreation,
  NEWEST_SYNC_PAGE_SIZE,
  remoteFromGroupSource,
  syncCreationsManifest,
  syncFullCreationsManifest,
  syncNewestCreationsManifest,
  withEmbeddedGroupMembers,
} from "./manifestSync";

const invoke = vi.fn();
const listMyCreations = vi.fn();

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
    listMyCreations: (...args: unknown[]) => listMyCreations(...args),
  }),
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
    if (cmd === "library_sync_status") {
      return emptyStatus;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

describe("manifestSync", () => {
  beforeEach(() => {
    invoke.mockReset();
    listMyCreations.mockReset();
    mockDownloadPending();
    listMyCreations.mockImplementation(async ({ offset }: { offset: number }) => {
      if (offset > 0) {
        return { images: [], hasMore: false };
      }
      return {
        images: [remoteImage(99, "Sunset")],
        hasMore: false,
      };
    });
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

  it("full sync paginates creations, applies the manifest, then downloads", async () => {
    const status = await syncFullCreationsManifest();
    expect(status.local).toBe(1);
    expect(listMyCreations).toHaveBeenCalledWith({ limit: 100, offset: 0 });
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
            thumbnailUrl: "https://www.parascene.com/cdn/99.jpg?variant=thumbnail",
          }),
        ],
      }),
    );
    expect(invoke).toHaveBeenCalledWith("library_download_pending", {
      limit: 80,
    });
  });

  it("syncCreationsManifest aliases full sync", async () => {
    await syncCreationsManifest();
    expect(listMyCreations).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(invoke).toHaveBeenCalledWith("library_apply_manifest", expect.any(Object));
  });

  it("newest sync on empty local catalog applies the first page", async () => {
    await syncNewestCreationsManifest();
    expect(listMyCreations).toHaveBeenCalledWith({
      limit: NEWEST_SYNC_PAGE_SIZE,
      offset: 0,
    });
    expect(invoke).toHaveBeenCalledWith("library_existing_creation_ids", {
      ids: ["99"],
    });
    expect(invoke).toHaveBeenCalledWith(
      "library_apply_manifest",
      expect.objectContaining({
        creations: [expect.objectContaining({ id: "99" })],
      }),
    );
    expect(invoke).toHaveBeenCalledWith("library_download_pending", {
      limit: 80,
    });
  });

  it("newest sync no-ops when a complete page is already local", async () => {
    const page = Array.from({ length: NEWEST_SYNC_PAGE_SIZE }, (_, i) =>
      remoteImage(1000 + i),
    );
    listMyCreations.mockResolvedValueOnce({ images: page, hasMore: true });
    invoke.mockImplementation(async (cmd: string, args?: { ids?: string[]; creations?: unknown[] }) => {
      if (cmd === "library_existing_creation_ids") {
        return args?.ids ?? [];
      }
      if (cmd === "library_apply_manifest") {
        expect(args?.creations).toEqual([]);
        return emptyStatus;
      }
      if (cmd === "library_download_pending") {
        return {
          downloaded: 0,
          failed: 0,
          skipped: 0,
          status: emptyStatus,
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await syncNewestCreationsManifest();
    expect(listMyCreations).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("library_apply_manifest", {
      creations: [],
    });
  });

  it("newest sync applies only unknown ids and continues past mixed pages", async () => {
    const firstPage = [
      remoteImage(1, "New A"),
      remoteImage(2, "Known"),
      remoteImage(3, "New B"),
    ];
    // Pad to complete-page size with known ids so the stop condition can fire later.
    const secondPage = Array.from({ length: NEWEST_SYNC_PAGE_SIZE }, (_, i) =>
      remoteImage(2000 + i),
    );
    listMyCreations
      .mockResolvedValueOnce({ images: firstPage, hasMore: true })
      .mockResolvedValueOnce({ images: secondPage, hasMore: true });

    const known = new Set(["2", ...secondPage.map((img) => String(img.id))]);
    const applied: string[][] = [];
    invoke.mockImplementation(async (cmd: string, args?: { ids?: string[]; creations?: Array<{ id: string }> }) => {
      if (cmd === "library_existing_creation_ids") {
        return (args?.ids ?? []).filter((id) => known.has(id));
      }
      if (cmd === "library_apply_manifest") {
        applied.push((args?.creations ?? []).map((c) => c.id));
        return {
          ...emptyStatus,
          total: args?.creations?.length ?? 0,
          remote: args?.creations?.length ?? 0,
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
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await syncNewestCreationsManifest();
    expect(listMyCreations).toHaveBeenCalledTimes(2);
    expect(applied).toEqual([["1", "3"]]);
  });

  it("newest sync pages through more than one page of new creations", async () => {
    const page1 = Array.from({ length: NEWEST_SYNC_PAGE_SIZE }, (_, i) =>
      remoteImage(3000 + i),
    );
    const page2 = Array.from({ length: NEWEST_SYNC_PAGE_SIZE }, (_, i) =>
      remoteImage(4000 + i),
    );
    const page3 = Array.from({ length: NEWEST_SYNC_PAGE_SIZE }, (_, i) =>
      remoteImage(5000 + i),
    );
    listMyCreations
      .mockResolvedValueOnce({ images: page1, hasMore: true })
      .mockResolvedValueOnce({ images: page2, hasMore: true })
      .mockResolvedValueOnce({ images: page3, hasMore: true });

    const known = new Set(page3.map((img) => String(img.id)));
    const appliedCounts: number[] = [];
    invoke.mockImplementation(async (cmd: string, args?: { ids?: string[]; creations?: unknown[] }) => {
      if (cmd === "library_existing_creation_ids") {
        return (args?.ids ?? []).filter((id) => known.has(id));
      }
      if (cmd === "library_apply_manifest") {
        appliedCounts.push(Array.isArray(args?.creations) ? args.creations.length : 0);
        return emptyStatus;
      }
      if (cmd === "library_download_pending") {
        return {
          downloaded: 0,
          failed: 0,
          skipped: 0,
          status: emptyStatus,
        };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await syncNewestCreationsManifest();
    expect(listMyCreations).toHaveBeenCalledTimes(3);
    expect(appliedCounts).toEqual([NEWEST_SYNC_PAGE_SIZE, NEWEST_SYNC_PAGE_SIZE]);
  });
});
