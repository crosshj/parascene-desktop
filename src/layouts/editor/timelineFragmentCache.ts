import { invoke } from "@tauri-apps/api/core";
import type { TimelineClip } from "../../project/types";
import {
  ensureRenderMediaLocal,
  timelineClipsToRenderInput,
} from "../../publisher/renderClient";
import {
  clipsForFragment,
  dirtyFragmentIndices,
  fragmentIndexAtSec,
  fragmentJobPriority,
  fragmentPlaybackHasContinuity,
  planTimelineFragments,
  type TimelineFragmentPlan,
  type TimelineFragmentSpec,
} from "./timelineFragmentPlan";

export type TimelineFragmentBakeResult = {
  path: string;
  index: number;
  startSec: number;
  durationSec: number;
  fingerprint: string;
};

export type ReadyTimelineFragment = TimelineFragmentBakeResult;

export type TimelineFragmentStatus = {
  ready: number;
  total: number;
  baking: boolean;
  queued: number;
  error: string | null;
  playheadReady: boolean;
};

export type TimelineFragmentCache = {
  setClips(input: {
    projectId: string;
    clips: readonly TimelineClip[];
    aspectRatio: string;
  }): void;
  setPlayhead(sec: number, playing: boolean): void;
  setTimeline(input: {
    projectId: string;
    clips: readonly TimelineClip[];
    aspectRatio: string;
    playheadSec: number;
    playing: boolean;
  }): void;
  fragmentCovering(sec: number): ReadyTimelineFragment | null;
  readyFragments(): ReadyTimelineFragment[];
  /** Current chunk is ready and the next one will be there before it ends. */
  hasContinuity(sec: number): boolean;
  isWindowReady(sec: number, aheadSec: number): boolean;
  status(): TimelineFragmentStatus;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  destroy(): void;
};

export type BakeTimelineFragmentFn = (input: {
  projectId: string;
  clips: readonly TimelineClip[];
  aspectRatio: string;
  fragment: TimelineFragmentSpec;
}) => Promise<TimelineFragmentBakeResult>;

export type TimelineFragmentCacheOptions = {
  /** Trailing debounce before spawning render jobs after a timeline edit. */
  debounceMs?: number;
  bake?: BakeTimelineFragmentFn;
};

/** Wait until the timeline stops changing before spending FFmpeg. */
export const FRAGMENT_JOB_DEBOUNCE_MS = 750;

export async function bakeTimelineFragment(input: {
  projectId: string;
  clips: readonly TimelineClip[];
  aspectRatio: string;
  fragment: TimelineFragmentSpec;
}): Promise<TimelineFragmentBakeResult> {
  const windowClips = clipsForFragment(input.clips, input.fragment);
  const renderInput = timelineClipsToRenderInput(windowClips);
  await ensureRenderMediaLocal(renderInput);
  return invoke<TimelineFragmentBakeResult>("library_bake_timeline_fragment", {
    projectId: input.projectId,
    clips: renderInput,
    aspectRatio: input.aspectRatio,
    index: input.fragment.index,
    startSec: input.fragment.startSec,
    durationSec: input.fragment.durationSec,
    fingerprint: input.fragment.fingerprint,
  });
}

export async function concatTimelineFragments(
  projectId: string,
  paths: readonly string[],
): Promise<{ path: string }> {
  return invoke<{ path: string }>("library_concat_timeline_fragments", {
    projectId,
    paths,
  });
}

export async function clearTimelineFragments(projectId: string): Promise<void> {
  const id = projectId.trim();
  if (!id) return;
  await invoke("library_clear_timeline_fragments", { projectId: id });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function createTimelineFragmentCache(
  options: TimelineFragmentCacheOptions = {},
): TimelineFragmentCache {
  const debounceMs = Math.max(0, options.debounceMs ?? FRAGMENT_JOB_DEBOUNCE_MS);
  const bake = options.bake ?? bakeTimelineFragment;

  let projectId = "";
  let clips: readonly TimelineClip[] = [];
  let aspectRatio = "16:9";
  let playheadSec = 0;
  let plan: TimelineFragmentPlan | null = null;
  let destroyed = false;
  let pumping = false;
  let error: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceGen = 0;
  const ready = new Map<number, ReadyTimelineFragment>();
  /** index → fingerprint currently encoding. Stale results are dropped. */
  const inflight = new Map<number, string>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const playheadIndex = () => {
    if (!plan) return 0;
    return fragmentIndexAtSec(playheadSec, Math.round(plan.durationSec * 30));
  };

  const coveringAt = (sec: number) => {
    if (!plan) return null;
    const index = fragmentIndexAtSec(
      sec,
      Math.round(plan.durationSec * 30),
    );
    const rec = ready.get(index);
    const spec = plan.fragments[index];
    if (!rec || !spec || rec.fingerprint !== spec.fingerprint) return null;
    return rec;
  };

  const isReady = (spec: TimelineFragmentSpec): boolean => {
    const rec = ready.get(spec.index);
    return Boolean(rec && rec.fingerprint === spec.fingerprint);
  };

  const nextJob = (): TimelineFragmentSpec | null => {
    if (!plan) return null;
    const playIndex = playheadIndex();
    const dirty = plan.fragments.filter((frag) => {
      if (isReady(frag)) return false;
      const bakingFp = inflight.get(frag.index);
      if (bakingFp === frag.fingerprint) return false;
      return true;
    });
    if (dirty.length === 0) return null;
    dirty.sort((a, b) => {
      const pa = fragmentJobPriority(a.index, playIndex);
      const pb = fragmentJobPriority(b.index, playIndex);
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    });
    return dirty[0] ?? null;
  };

  const queuedCount = () => {
    if (!plan) return 0;
    return plan.fragments.filter((frag) => !isReady(frag)).length;
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (!destroyed) {
      const spec = nextJob();
      if (!spec || !projectId.trim() || !plan) break;
      inflight.set(spec.index, spec.fingerprint);
      error = null;
      notify();
      try {
        const result = await bake({
          projectId,
          clips,
          aspectRatio,
          fragment: spec,
        });
        if (destroyed) return;
        inflight.delete(spec.index);
        const current = plan.fragments[result.index];
        if (
          !current ||
          current.fingerprint !== result.fingerprint ||
          current.fingerprint !== spec.fingerprint
        ) {
          continue;
        }
        ready.set(result.index, result);
        error = null;
        notify();
      } catch (caught) {
        if (destroyed) return;
        inflight.delete(spec.index);
        error = caught instanceof Error ? caught.message : String(caught);
        notify();
        await wait(800);
      }
    }
    pumping = false;
    notify();
  };

  const applyPlan = (nextPlan: TimelineFragmentPlan) => {
    for (const key of [...ready.keys()]) {
      const spec = nextPlan.fragments[key];
      const rec = ready.get(key);
      if (!spec || !rec || spec.fingerprint !== rec.fingerprint) {
        ready.delete(key);
      }
    }
    plan = nextPlan;
  };

  const scheduleJobs = (immediate: boolean) => {
    if (destroyed) return;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediate || debounceMs === 0) {
      void pump();
      return;
    }
    const gen = ++debounceGen;
    debounceTimer = setTimeout(() => {
      if (destroyed || gen !== debounceGen) return;
      debounceTimer = null;
      void pump();
    }, debounceMs);
  };

  const commitClips = (
    input: {
      projectId: string;
      clips: readonly TimelineClip[];
      aspectRatio: string;
    },
    spawn: "debounce" | "now" | "skip",
  ) => {
    const nextId = input.projectId.trim();
    const nextAspect = input.aspectRatio.trim() || "16:9";
    if (nextId !== projectId) {
      ready.clear();
      inflight.clear();
    } else if (nextAspect !== aspectRatio && projectId) {
      void clearTimelineFragments(projectId).catch(() => {});
      ready.clear();
      inflight.clear();
    }
    projectId = nextId;
    clips = input.clips;
    aspectRatio = nextAspect;
    const nextPlan = planTimelineFragments(clips, aspectRatio);
    const planChanged =
      !plan ||
      plan.aspectRatio !== nextPlan.aspectRatio ||
      plan.fragmentCount !== nextPlan.fragmentCount ||
      dirtyFragmentIndices(plan, nextPlan).length > 0;
    applyPlan(nextPlan);
    notify();
    if (!planChanged && spawn !== "now") return;
    if (spawn === "skip") return;
    scheduleJobs(spawn === "now");
  };

  return {
    setClips(input) {
      if (destroyed) return;
      commitClips(input, "debounce");
    },
    setPlayhead(sec) {
      if (destroyed) return;
      playheadSec = sec;
      if (pumping || debounceTimer != null) return;
      if (nextJob()) void pump();
    },
    setTimeline(input) {
      if (destroyed) return;
      playheadSec = input.playheadSec;
      commitClips(input, "debounce");
    },
    fragmentCovering(sec) {
      return coveringAt(sec);
    },
    readyFragments() {
      if (!plan) return [];
      const out: ReadyTimelineFragment[] = [];
      for (const spec of plan.fragments) {
        const rec = ready.get(spec.index);
        if (rec && rec.fingerprint === spec.fingerprint) out.push(rec);
      }
      return out;
    },
    hasContinuity(sec) {
      if (!plan) return false;
      const covering = coveringAt(sec);
      const nextStart = covering
        ? covering.startSec + covering.durationSec
        : sec;
      return fragmentPlaybackHasContinuity({
        sec,
        sequenceEndSec: plan.durationSec,
        covering,
        nextReady: coveringAt(nextStart) != null,
      });
    },
    isWindowReady(sec, aheadSec) {
      if (!plan || plan.fragments.length === 0) return false;
      const start = Math.max(0, sec);
      const end = sec + Math.max(0, aheadSec);
      let needed = 0;
      for (const spec of plan.fragments) {
        const fragEnd = spec.startSec + spec.durationSec;
        if (fragEnd <= start || spec.startSec >= end) continue;
        needed += 1;
        if (!isReady(spec)) return false;
      }
      return needed > 0;
    },
    status() {
      return {
        ready: ready.size,
        total: plan?.fragmentCount ?? 0,
        baking: pumping || inflight.size > 0,
        queued: queuedCount(),
        error,
        playheadReady: Boolean(plan && this.fragmentCovering(playheadSec)),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (destroyed) return;
      ready.clear();
      inflight.clear();
      debounceGen += 1;
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      notify();
      scheduleJobs(true);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      debounceGen += 1;
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      listeners.clear();
      ready.clear();
      inflight.clear();
      plan = null;
    },
  };
}
