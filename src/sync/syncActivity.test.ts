import { describe, expect, it } from "vitest";
import {
  applySyncItemEvent,
  clearFinishedSyncActivity,
  countFinishedSyncActivity,
  syncActivityKey,
} from "./syncActivity";

describe("syncActivity", () => {
  it("appends new items and updates in place without reordering", () => {
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
    expect(items.map((i) => i.key)).toEqual(["thumb:a", "media:b"]);
    expect(items[0]).toMatchObject({
      key: syncActivityKey("thumb", "a"),
      state: "done",
    });
  });

  it("keeps failure detail on the row", () => {
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
      kind: "thumb",
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
      kind: "media",
      state: "failed",
    });
    expect(countFinishedSyncActivity(items)).toBe(2);
    expect(clearFinishedSyncActivity(items).map((i) => i.id)).toEqual(["2"]);
  });
});
