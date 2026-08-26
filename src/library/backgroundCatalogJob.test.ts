import { describe, expect, it } from "vitest";
import {
  catalogJobHeadline,
  catalogJobMode,
  isActiveJobStatus,
  isCatalogJobKind,
  pickActiveCatalogJob,
} from "./backgroundCatalogJob";

describe("backgroundCatalogJob", () => {
  it("recognizes catalog kinds and in-flight statuses", () => {
    expect(isCatalogJobKind("sync_newest")).toBe(true);
    expect(isCatalogJobKind("sync_full")).toBe(true);
    expect(isCatalogJobKind("parascene_generate")).toBe(false);
    expect(isActiveJobStatus("queued")).toBe(true);
    expect(isActiveJobStatus("running")).toBe(true);
    expect(isActiveJobStatus("waiting")).toBe(true);
    expect(isActiveJobStatus("done")).toBe(false);
  });

  it("maps kinds to sync button modes", () => {
    expect(catalogJobMode("sync_newest")).toBe("newest");
    expect(catalogJobMode("sync_full")).toBe("full");
    expect(catalogJobMode("cloud_repair")).toBe(null);
  });

  it("prefers a running catalog job over a queued one", () => {
    const picked = pickActiveCatalogJob([
      {
        kind: "sync_newest",
        status: "queued",
        updatedAt: "2026-08-24T20:00:02Z",
      },
      {
        kind: "parascene_generate",
        status: "running",
        updatedAt: "2026-08-24T20:00:03Z",
      },
      {
        kind: "sync_full",
        status: "running",
        updatedAt: "2026-08-24T20:00:01Z",
      },
    ]);
    expect(picked?.kind).toBe("sync_full");
  });

  it("returns null when no catalog job is in flight", () => {
    expect(
      pickActiveCatalogJob([
        { kind: "sync_newest", status: "done" },
        { kind: "sync_full", status: "failed" },
      ]),
    ).toBeNull();
  });

  it("uses queued copy when the worker is busy with something else", () => {
    expect(
      catalogJobHeadline({
        kind: "sync_newest",
        status: "queued",
      }),
    ).toEqual({
      label: "Queued",
      title: "Sync newest is waiting for another job",
    });
  });

  it("surfaces the job progress note while running in the background", () => {
    expect(
      catalogJobHeadline({
        kind: "sync_full",
        status: "running",
        progressNote: "Fetching page 12…",
      }),
    ).toEqual({
      label: "Background",
      title: "Fetching page 12…",
    });
  });
});
