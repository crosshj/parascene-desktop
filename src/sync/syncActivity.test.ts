import { describe, expect, it } from "vitest";
import {
  applySyncItemEvent,
  clearFinishedSyncActivity,
  countFinishedSyncActivity,
  MAX_JOB_HISTORY,
  partitionSyncActivity,
  syncActivityKey,
} from "./syncActivity";

describe("syncActivity", () => {
  it("keeps live downloads and drops them when done", () => {
    let items = applySyncItemEvent([], {
      id: "a",
      title: "Alpha",
      kind: "thumb",
      state: "queued",
    });
    items = applySyncItemEvent(items, {
      id: "b",
      title: "Beta",
      kind: "media",
      state: "queued",
    });
    expect(items.map((i) => i.key)).toEqual(["thumb:a", "media:b"]);

    items = applySyncItemEvent(items, {
      id: "a",
      title: "Alpha",
      kind: "thumb",
      state: "done",
    });
    expect(items.map((i) => i.key)).toEqual(["media:b"]);
  });

  it("keeps failure detail on download rows", () => {
    const items = applySyncItemEvent([], {
      id: "1",
      title: "One",
      kind: "media",
      state: "failed",
      detail: "HTTP 403 (sign in required)",
    });
    expect(items[0].detail).toBe("HTTP 403 (sign in required)");
  });

  it("clears finished items only", () => {
    let items = applySyncItemEvent([], {
      id: "1",
      title: "One",
      kind: "catalog",
      state: "done",
    });
    items = applySyncItemEvent(items, {
      id: "2",
      title: "Two",
      kind: "media",
      state: "active",
    });
    items = applySyncItemEvent(items, {
      id: "3",
      title: "Three",
      kind: "folders",
      state: "failed",
    });
    expect(countFinishedSyncActivity(items)).toBe(2);
    expect(clearFinishedSyncActivity(items).map((i) => i.id)).toEqual(["2"]);
  });

  it("tracks repair rows as jobs", () => {
    let items = applySyncItemEvent([], {
      id: "9",
      title: "Clip",
      kind: "repair",
      state: "active",
      detail: "Rebuilding local fit + upload",
    });
    expect(items[0]).toMatchObject({
      key: syncActivityKey("repair", "9"),
      kind: "repair",
      state: "active",
    });
    items = applySyncItemEvent(items, {
      id: "9",
      title: "Clip",
      kind: "repair",
      state: "done",
      detail: "Local fit uploaded",
    });
    expect(items[0]).toMatchObject({ state: "done", kind: "repair" });
    expect(partitionSyncActivity(items).jobs).toHaveLength(1);
  });

  it("caps finished job history instead of retaining hundreds of downloads", () => {
    let items: ReturnType<typeof applySyncItemEvent> = [];
    for (let i = 0; i < MAX_JOB_HISTORY + 5; i++) {
      items = applySyncItemEvent(items, {
        id: `job-${i}`,
        title: `Job ${i}`,
        kind: "catalog",
        state: "done",
      });
    }
    const { jobs, downloads } = partitionSyncActivity(items);
    expect(jobs).toHaveLength(MAX_JOB_HISTORY);
    expect(jobs[0]?.id).toBe("job-5");
    expect(downloads).toHaveLength(0);

    for (let i = 0; i < 30; i++) {
      items = applySyncItemEvent(items, {
        id: `thumb-${i}`,
        title: `Thumb ${i}`,
        kind: "thumb",
        state: "done",
      });
    }
    expect(partitionSyncActivity(items).downloads).toHaveLength(0);
  });
});
