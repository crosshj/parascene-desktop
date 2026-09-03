import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { TimelineClip } from "../../project/types";
import { createTimelineFragmentCache } from "./timelineFragmentCache";
import type { TimelineFragmentBakeResult } from "./timelineFragmentCache";
import type { TimelineFragmentSpec } from "./timelineFragmentPlan";
import { planTimelineFragments, PREVIEW_ENCODE_TAG } from "./timelineFragmentPlan";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

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
  vi.mocked(invoke).mockReset();
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
    expect(order).toContain(0);
    expect(order.length).toBeLessThanOrEqual(2);

    cache.setPlayhead(8, true);
    pending[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.fragmentCovering(0)?.index).toBe(0);
    expect(order).toContain(4);

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

  it("demandPlayableWindow bypasses edit debounce for admission slots", async () => {
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
      clips: [clip({ id: "a", startSec: 0, endSec: 10, assetId: "v1" })],
    });
    expect(baked).toEqual([]);

    cache.demandPlayableWindow(4);
    await Promise.resolve();
    await Promise.resolve();
    expect(baked.length).toBeGreaterThan(0);
    expect(baked).toContain(2);

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

  it("hydrates ready fragments from disk snapshot without baking", async () => {
    const baked: number[] = [];
    const clips = [clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" })];
    const planned = planTimelineFragments(clips, "16:9", undefined, "low");
    const spec = planned.fragments[0]!;
    const cache = createTimelineFragmentCache({
      debounceMs: 750,
      bake: async ({ fragment }) => {
        baked.push(fragment.index);
        return resultFor(fragment);
      },
    });
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd !== "library_read_timeline_preview_snapshot") {
        throw new Error(`unexpected invoke ${cmd}`);
      }
      return {
        encodeTag: PREVIEW_ENCODE_TAG,
        aspectRatio: "16:9",
        quality: "low",
        fragments: [
          {
            index: spec.index,
            startSec: spec.startSec,
            durationSec: spec.durationSec,
            fingerprint: spec.fingerprint,
            path: "/cache/restored.mp4",
          },
        ],
      };
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      quality: "low",
      clips,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(baked).toEqual([]);
    expect(cache.status().ready).toBe(1);
    expect(cache.fragmentCovering(0)?.path).toBe("/cache/restored.mp4");

    cache.destroy();
  });

  it("marks depwait when source media is not local", async () => {
    vi.useFakeTimers();
    const cache = createTimelineFragmentCache({
      debounceMs: 0,
      bake: async () => {
        throw Object.assign(new Error("Waiting for local source media"), {
          depwait: true,
        });
      },
    });

    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [clip({ id: "a", startSec: 0, endSec: 4, assetId: "v1" })],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.status().depwait).toBe(true);
    expect(cache.status().error).toBeNull();
    expect(cache.isDepwaitAt(0)).toBe(true);
    expect(cache.fragmentCovering(0)).toBeNull();

    cache.destroy();
  });

  it("drops a ready entry and rebakes when a fragment path is invalidated", async () => {
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
      clips: [clip({ id: "a", startSec: 0, endSec: 4, assetId: "v1" })],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.fragmentCovering(0)).not.toBeNull();
    expect(baked).toEqual([0, 1]);

    const missingPath = cache.fragmentCovering(0)!.path;
    baked.length = 0;
    cache.invalidateFragmentAtPath(missingPath);
    expect(cache.fragmentCovering(0)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(baked).toContain(0);

    cache.destroy();
  });

  it("does not notify or reconcile when setClips produces an identical plan", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const cache = createTimelineFragmentCache({
      debounceMs: 750,
      bake: async ({ fragment }) => resultFor(fragment),
    });
    const clips = [clip({ id: "a", startSec: 0, endSec: 2, assetId: "v1" })];
    let notifies = 0;
    cache.subscribe(() => {
      notifies += 1;
    });
    cache.setClips({ projectId: "p1", aspectRatio: "16:9", clips });
    const afterFirst = notifies;
    const snapshotCalls = vi
      .mocked(invoke)
      .mock.calls.filter(
        (call) => call[0] === "library_read_timeline_preview_snapshot",
      ).length;
    cache.setClips({
      projectId: "p1",
      aspectRatio: "16:9",
      clips: [...clips],
    });
    expect(notifies).toBe(afterFirst);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(
          (call) => call[0] === "library_read_timeline_preview_snapshot",
        ).length,
    ).toBe(snapshotCalls);
    cache.destroy();
  });
});
