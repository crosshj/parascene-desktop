import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../project/types";
import { createTimelineFragmentCache } from "./timelineFragmentCache";
import type { TimelineFragmentBakeResult } from "./timelineFragmentCache";
import type { TimelineFragmentSpec } from "./timelineFragmentPlan";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    ...partial,
  };
}

function resultFor(fragment: TimelineFragmentSpec): TimelineFragmentBakeResult {
  return {
    path: `/tmp/frag-${fragment.index}-${fragment.fingerprint}.mp4`,
    index: fragment.index,
    startSec: fragment.startSec,
    durationSec: fragment.durationSec,
    fingerprint: fragment.fingerprint,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTimelineFragmentCache", () => {
  it("debounces spawn, invalidates only dirty fragments, and keeps ready ones", async () => {
    vi.useFakeTimers();
    const baked: number[] = [];
    const cache = createTimelineFragmentCache({
      debounceMs: 750,
      bake: async ({ fragment }) => {
        baked.push(fragment.index);
        return resultFor(fragment);
      },
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v2" }),
      ],
    });
    expect(cache.status().ready).toBe(0);
    expect(baked).toEqual([]);

    await vi.advanceTimersByTimeAsync(749);
    expect(baked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.status().ready).toBe(3);
    expect(cache.fragmentCovering(0)?.index).toBe(0);
    expect(cache.fragmentCovering(5)?.index).toBe(2);

    const first = cache.fragmentCovering(0);
    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v3" }),
      ],
    });
    expect(cache.fragmentCovering(0)?.path).toBe(first?.path);
    expect(cache.fragmentCovering(5)).toBeNull();

    cache.destroy();
  });

  it("reprioritizes remaining jobs toward the playhead without dropping a finished fragment", async () => {
    vi.useFakeTimers();
    const order: number[] = [];
    const pending: Array<() => void> = [];
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: ({ fragment }) =>
        new Promise((resolve) => {
          order.push(fragment.index);
          pending.push(() => resolve(resultFor(fragment)));
        }),
    });

    cache.setPlayhead(0, false);
    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [clip({ id: "a", startSec: 0, endSec: 10, assetId: "v1" })],
    });
    await Promise.resolve();
    expect(order).toEqual([0]);

    cache.setPlayhead(8, true);
    pending[0]?.();
    await Promise.resolve();
    expect(cache.fragmentCovering(0)?.index).toBe(0);
    expect(order[1]).toBe(4);

    cache.destroy();
  });

  it("ignores a late bake whose fingerprint no longer matches", async () => {
    vi.useFakeTimers();
    const pendingByIndex = new Map<number, () => void>();
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: ({ fragment }) =>
        new Promise((resolve) => {
          pendingByIndex.set(fragment.index, () =>
            resolve(resultFor(fragment)),
          );
        }),
    });

    cache.setPlayhead(5, false);
    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v2" }),
      ],
    });
    await Promise.resolve();
    expect(pendingByIndex.has(2)).toBe(true);

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [
        clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" }),
        clip({ id: "b", startSec: 5, endSec: 6, assetId: "v3" }),
      ],
    });
    const stale = pendingByIndex.get(2);
    pendingByIndex.delete(2);
    stale?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.fragmentCovering(0)).toBeNull();
    const late = cache.fragmentCovering(5);
    expect(late === null || late.path.includes(late.fingerprint)).toBe(true);

    cache.destroy();
  });

  it("reports continuity only when the next fragment is ready near a boundary", async () => {
    vi.useFakeTimers();
    const pendingByIndex = new Map<number, () => void>();
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: ({ fragment }) =>
        new Promise((resolve) => {
          pendingByIndex.set(fragment.index, () =>
            resolve(resultFor(fragment)),
          );
        }),
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [clip({ id: "a", startSec: 0, endSec: 10, assetId: "v1" })],
    });
    await Promise.resolve();
    expect(pendingByIndex.has(0)).toBe(true);
    expect(cache.hasContinuity(0.5)).toBe(false);

    pendingByIndex.get(0)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.fragmentCovering(0)?.index).toBe(0);
    expect(cache.hasContinuity(0.5)).toBe(true);
    expect(cache.hasContinuity(1.9)).toBe(false);

    pendingByIndex.get(1)?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.hasContinuity(1.9)).toBe(true);

    cache.destroy();
  });

  it("refresh wipes the disk cache and re-bakes fragments that were already ready", async () => {
    const baked: number[] = [];
    const cleared: string[] = [];
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: async ({ fragment }) => {
        baked.push(fragment.index);
        return resultFor(fragment);
      },
      clear: async (projectId) => {
        cleared.push(projectId);
      },
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" })],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.status().ready).toBe(1);
    expect(baked).toEqual([0]);

    cache.refresh();
    expect(cache.status().ready).toBe(0);
    expect(cache.status().baking).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toEqual(["p1"]);
    expect(baked).toEqual([0, 0]);
    expect(cache.status().ready).toBe(1);

    cache.destroy();
  });

  it("plans only through video content when audio is longer", async () => {
    vi.useFakeTimers();
    const baked: number[] = [];
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: async ({ fragment }) => {
        baked.push(fragment.index);
        return resultFor(fragment);
      },
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [
        clip({ id: "a", startSec: 0, endSec: 4, assetId: "v1" }),
        clip({
          id: "bed",
          startSec: 0,
          endSec: 100,
          lane: "audio",
          kind: "audio",
          assetId: "a1",
        }),
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.status().total).toBe(2);
    expect(cache.videoExtentSec()).toBe(4);
    expect(cache.hasContinuity(50)).toBe(true);
    expect(cache.isWindowReady(50, 2)).toBe(true);
    expect(baked.length).toBe(2);

    cache.destroy();
  });

  it("backs off a failing fragment and continues baking others", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const errors: Array<string | null> = [];
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: async ({ fragment }) => {
        attempts.push(fragment.index);
        if (fragment.index === 0) {
          throw new Error("bake failed");
        }
        return resultFor(fragment);
      },
    });
    cache.subscribe(() => {
      errors.push(cache.status().error);
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [clip({ id: "a", startSec: 0, endSec: 4, assetId: "v1" })],
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(errors.some((e) => String(e ?? "").includes("bake failed"))).toBe(
      true,
    );
    expect(cache.fragmentCovering(2)?.index).toBe(1);
    expect(attempts.filter((i) => i === 0).length).toBe(1);
    expect(attempts).toContain(1);

    cache.destroy();
  });
});
