import { invoke } from "@tauri-apps/api/core";
import type { TimelineClip } from "../../project/types";
import {
  DEFAULT_PREVIEW_QUALITY,
  type PreviewQuality,
} from "../../settings/previewQuality";
import {
  filterRenderMediaLocal,
  timelineClipsToRenderInput,
} from "../../publisher/renderClient";
import {
  clipsForFragment,
  dirtyFragmentIndices,
  fragmentIndexAtSec,
  fragmentJobPriority,
  fragmentPlaybackHasContinuity,
  planTimelineFragments,
  timelineVideoExtentSec,
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
    /** Preview encode quality; changes re-fingerprint and re-bake fragments. */
    quality?: PreviewQuality;
  }): void;
  setPlayhead(sec: number, playing: boolean): void;
  setTimeline(input: {
    projectId: string;
    clips: readonly TimelineClip[];
    aspectRatio: string;
    playheadSec: number;
    playing: boolean;
    quality?: PreviewQuality;
  }): void;
  fragmentCovering(sec: number): ReadyTimelineFragment | null;
  readyFragments(): ReadyTimelineFragment[];
  /** Current chunk is ready and the next one will be there before it ends. */
  hasContinuity(sec: number): boolean;
  isWindowReady(sec: number, aheadSec: number): boolean;
  /** Picture extent — past this, audio plays without video fragments. */
  videoExtentSec(): number;
  status(): TimelineFragmentStatus;
  /** Surface a playback-side failure (e.g. CSP-blocked fragment fetch). */
  reportError(message: string | null): void;
  subscribe(listener: () => void): () => void;
  refresh(): void;
  destroy(): void;
};

export type BakeTimelineFragmentFn = (input: {
  projectId: string;
  clips: readonly TimelineClip[];
  aspectRatio: string;
  quality: PreviewQuality;
  fragment: TimelineFragmentSpec;
}) => Promise<TimelineFragmentBakeResult>;

export type TimelineFragmentCacheOptions = {
  /** Trailing debounce before spawning render jobs after a timeline edit. */
  debounceMs?: number;
  bake?: BakeTimelineFragmentFn;
  clear?: (projectId: string) => Promise<void>;
};

/** Wait until the timeline stops changing before spending FFmpeg. */
export const FRAGMENT_JOB_DEBOUNCE_MS = 750;
/** After a bake error, skip that fragment briefly so others can proceed. */
const BAKE_FAILURE_BACKOFF_MS = 4000;

export async function bakeTimelineFragment(input: {
  projectId: string;
  clips: readonly TimelineClip[];
  aspectRatio: string;
  quality: PreviewQuality;
  fragment: TimelineFragmentSpec;
}): Promise<
  TimelineFragmentBakeResult & {
    readyIds: string[];
    missingIds: string[];
  }
> {
  const windowClips = clipsForFragment(input.clips, input.fragment).filter(
    (clip) => clip.isAddAssetPlaceholder !== true,
  );
  const renderInput = timelineClipsToRenderInput(windowClips);
  const { clips: readyClips, readyIds, missingIds } =
    await filterRenderMediaLocal(renderInput);
  const result = await invoke<TimelineFragmentBakeResult>(
    "library_bake_timeline_fragment",
    {
      projectId: input.projectId,
      clips: readyClips,
      aspectRatio: input.aspectRatio,
      quality: input.quality,
      index: input.fragment.index,
      startSec: input.fragment.startSec,
      durationSec: input.fragment.durationSec,
      fingerprint: input.fragment.fingerprint,
    },
  );
  return { ...result, readyIds, missingIds };
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
  const customBake = options.bake;
  const clear = options.clear ?? clearTimelineFragments;

  let projectId = "";
  let clips: readonly TimelineClip[] = [];
  let aspectRatio = "16:9";
  let quality: PreviewQuality = DEFAULT_PREVIEW_QUALITY;
  let playheadSec = 0;
  let plan: TimelineFragmentPlan | null = null;
  let destroyed = false;
  let pumping = false;
  /** True while a manual rebuild is wiping the on-disk cache. */
  let pausingForRefresh = false;
  let bakeEpoch = 0;
  let error: string | null = null;
  let errorSource: "bake" | "playback" | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceGen = 0;
  const ready = new Map<number, ReadyTimelineFragment>();
  /** index → fingerprint currently encoding. Stale results are dropped. */
  const inflight = new Map<number, string>();
  /** index → earliest time we may retry after a bake failure. */
  const failureBackoffUntil = new Map<number, number>();
  /** Known-local asset ids — drives readiness bits in fingerprints. */
  let localAssetIds: Set<string> | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const mergeLocality = (readyIds: string[], missingIds: string[]): boolean => {
    if (!localAssetIds) {
      if (readyIds.length === 0 && missingIds.length === 0) return false;
      // Leave optimistic mode so missing assets fingerprint as not-ready.
      localAssetIds = new Set(readyIds);
      return true;
    }
    let changed = false;
    for (const id of readyIds) {
      if (!localAssetIds.has(id)) {
        localAssetIds.add(id);
        changed = true;
      }
    }
    for (const id of missingIds) {
      if (localAssetIds.has(id)) {
        localAssetIds.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  const playheadIndex = () => {
    if (!plan) return 0;
    return fragmentIndexAtSec(playheadSec, Math.round(plan.durationSec * 30));
  };

  const coveringAt = (sec: number) => {
    if (!plan) return null;
    if (sec >= plan.durationSec - 1e-3) return null;
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
    if (!plan || pausingForRefresh) return null;
    const playIndex = playheadIndex();
    const now = Date.now();
    const dirty = plan.fragments.filter((frag) => {
      if (isReady(frag)) return false;
      const bakingFp = inflight.get(frag.index);
      if (bakingFp === frag.fingerprint) return false;
      const until = failureBackoffUntil.get(frag.index);
      if (until != null && until > now) return false;
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

  const applyPlan = (nextPlan: TimelineFragmentPlan) => {
    for (const key of [...ready.keys()]) {
      const spec = nextPlan.fragments[key];
      const rec = ready.get(key);
      if (!spec || !rec || spec.fingerprint !== rec.fingerprint) {
        ready.delete(key);
      }
    }
    for (const key of [...failureBackoffUntil.keys()]) {
      if (!nextPlan.fragments[key]) failureBackoffUntil.delete(key);
    }
    plan = nextPlan;
  };

  const replanFromLocality = () => {
    const nextPlan = planTimelineFragments(
      clips,
      aspectRatio,
      undefined,
      quality,
      localAssetIds,
    );
    applyPlan(nextPlan);
    notify();
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!destroyed) {
        const spec = nextJob();
        if (!spec || !projectId.trim() || !plan) break;
        const epoch = bakeEpoch;
        inflight.set(spec.index, spec.fingerprint);
        notify();
        try {
          const result = customBake
            ? await customBake({
                projectId,
                clips,
                aspectRatio,
                quality,
                fragment: spec,
              })
            : await bakeTimelineFragment({
                projectId,
                clips,
                aspectRatio,
                quality,
                fragment: spec,
              });
          inflight.delete(spec.index);
          failureBackoffUntil.delete(spec.index);
          if (destroyed || epoch !== bakeEpoch) continue;
          if (
            !customBake &&
            "readyIds" in result &&
            "missingIds" in result &&
            Array.isArray(result.readyIds) &&
            Array.isArray(result.missingIds) &&
            mergeLocality(result.readyIds, result.missingIds)
          ) {
            replanFromLocality();
          }
          const current = plan.fragments[result.index];
          if (
            !current ||
            current.fingerprint !== result.fingerprint ||
            current.fingerprint !== spec.fingerprint
          ) {
            // Locality change may have dirtied this slot — keep pumping.
            continue;
          }
          ready.set(result.index, {
            path: result.path,
            index: result.index,
            startSec: result.startSec,
            durationSec: result.durationSec,
            fingerprint: result.fingerprint,
          });
          if (errorSource === "bake") {
            error = null;
            errorSource = null;
          }
          notify();
        } catch (caught) {
          inflight.delete(spec.index);
          if (destroyed || epoch !== bakeEpoch) continue;
          error = caught instanceof Error ? caught.message : String(caught);
          errorSource = "bake";
          failureBackoffUntil.set(
            spec.index,
            Date.now() + BAKE_FAILURE_BACKOFF_MS,
          );
          notify();
          // Move on to the next dirty fragment; do not hot-loop one failure.
          await wait(200);
        }
      }
    } finally {
      pumping = false;
      if (!destroyed) notify();
    }
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
      quality?: PreviewQuality;
    },
    spawn: "debounce" | "now" | "skip",
  ) => {
    const nextId = input.projectId.trim();
    const nextAspect = input.aspectRatio.trim() || "16:9";
    const nextQuality = input.quality ?? quality;
    if (nextId !== projectId) {
      ready.clear();
      inflight.clear();
      failureBackoffUntil.clear();
      localAssetIds = null;
    } else if (
      (nextAspect !== aspectRatio || nextQuality !== quality) &&
      projectId
    ) {
      void clearTimelineFragments(projectId).catch(() => {});
      ready.clear();
      inflight.clear();
      failureBackoffUntil.clear();
    }
    projectId = nextId;
    clips = input.clips;
    aspectRatio = nextAspect;
    quality = nextQuality;
    const nextPlan = planTimelineFragments(
      clips,
      aspectRatio,
      undefined,
      quality,
      localAssetIds,
    );
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
      // Past picture content: audio-only region needs no fragments.
      if (sec >= plan.durationSec - 1e-3) return true;
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
      if (!plan) return false;
      if (plan.fragments.length === 0) {
        // No video content — audio-only timeline is always "ready".
        return true;
      }
      const start = Math.max(0, sec);
      if (start >= plan.durationSec - 1e-3) return true;
      const end = Math.min(sec + Math.max(0, aheadSec), plan.durationSec);
      let needed = 0;
      for (const spec of plan.fragments) {
        const fragEnd = spec.startSec + spec.durationSec;
        if (fragEnd <= start || spec.startSec >= end) continue;
        needed += 1;
        if (!isReady(spec)) return false;
      }
      return needed > 0;
    },
    videoExtentSec() {
      return plan?.durationSec ?? timelineVideoExtentSec(clips);
    },
    status() {
      const extent = plan?.durationSec ?? 0;
      const pastVideo = playheadSec >= extent - 1e-3;
      return {
        ready: ready.size,
        total: plan?.fragmentCount ?? 0,
        baking: pumping || inflight.size > 0 || pausingForRefresh,
        queued: queuedCount(),
        error,
        playheadReady:
          pastVideo || Boolean(plan && this.fragmentCovering(playheadSec)),
      };
    },
    reportError(message) {
      if (destroyed) return;
      const next = message?.trim() || null;
      if (next === error && (next == null || errorSource === "playback")) return;
      error = next;
      errorSource = next ? "playback" : null;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      if (destroyed) return;
      bakeEpoch += 1;
      const epoch = bakeEpoch;
      ready.clear();
      inflight.clear();
      failureBackoffUntil.clear();
      error = null;
      errorSource = null;
      pausingForRefresh = true;
      debounceGen += 1;
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      notify();
      const id = projectId.trim();
      const kick = () => {
        if (destroyed || epoch !== bakeEpoch) return;
        pausingForRefresh = false;
        notify();
        scheduleJobs(true);
      };
      if (!id) {
        kick();
        return;
      }
      void clear(id).then(kick, kick);
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
      failureBackoffUntil.clear();
      plan = null;
    },
  };
}
