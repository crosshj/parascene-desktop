import { describe, expect, it } from "vitest";
import {
  creationPageUrl,
  formatBytes,
  formatLastSync,
  syncCountsSummary,
  syncDiskSummary,
  unsyncableMediaCount,
  unsyncableThumbCount,
  withoutCloudUrlLabel,
} from "./syncState";

const baseStatus = {
  rootPath: "/tmp",
  lastSyncAt: null as string | null,
  total: 4,
  local: 1,
  remote: 3,
  queued: 0,
  downloading: 0,
  failed: 0,
  withThumb: 1,
  withMedia: 1,
  missingThumbCacheable: 2,
  missingMediaCacheable: 2,
  mediaBytes: 0,
  thumbsBytes: 0,
  withoutCloudUrls: [],
};

describe("syncState", () => {
  it("formats missing last sync", () => {
    expect(formatLastSync(null)).toBe("Never");
  });

  it("summarizes catalog counts", () => {
    expect(syncCountsSummary(baseStatus)).toBe(
      "1 local · 3 remote · 0 queued · 0 downloading · 0 failed",
    );
  });

  it("formats disk sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(5_050_000_000)).toBe("4.7 GB");
    expect(
      syncDiskSummary({
        ...baseStatus,
        mediaBytes: 5_050_000_000,
        thumbsBytes: 383 * 1024 * 1024,
      }),
    ).toBe("4.7 GB media · 383 MB previews");
  });

  it("counts creations without cloud URLs", () => {
    expect(
      unsyncableThumbCount({
        ...baseStatus,
        total: 2842,
        withThumb: 2839,
        missingThumbCacheable: 0,
      }),
    ).toBe(3);
    expect(
      unsyncableMediaCount({
        ...baseStatus,
        total: 2842,
        withMedia: 2839,
        missingMediaCacheable: 0,
      }),
    ).toBe(3);
  });

  it("labels without-cloud-url rows", () => {
    expect(
      withoutCloudUrlLabel({
        id: "abc",
        title: "Title",
        filename: "creating_1.png",
      }),
    ).toBe("creating_1.png");
    expect(
      withoutCloudUrlLabel({ id: "abc", title: "Title", filename: null }),
    ).toBe("Title");
  });

  it("builds Parascene creation page URLs", () => {
    expect(creationPageUrl("https://www.parascene.com", "7805")).toBe(
      "https://www.parascene.com/creations/7805",
    );
    expect(creationPageUrl("https://www.parascene.com/", "a/b")).toBe(
      "https://www.parascene.com/creations/a%2Fb",
    );
  });
});
