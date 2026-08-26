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
  PREVIEW_ENCODE_TAG,
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
  /** Covering slot waits on non-local source media (not a bake error). */
  depwait: boolean;
};

export type TimelinePreviewSnapshotFragment = {
  index: number;
  startSec: number;
  durationSec: number;
  fingerprint: string;
  path: string;
};

export type TimelinePreviewSnapshot = {
  encodeTag: string;
  aspectRatio: string;
  quality: string;
  fragments: TimelinePreviewSnapshotFragment[];
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
  /** Play/seek admission: bake covering + next immediately, bypass edit debounce. */
  demandPlayableWindow(sec: number): void;
  /** True when the fragment at sec waits on non-local source media. */
  isDepwaitAt(sec: number): boolean;
  /** Drop a stale ready entry and demand a rebake (F11). */
  invalidateFragmentAtPath(path: string): void;
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
/** Demanded play/seek slots may encode concurrently. */
const MAX_CONCURRENT_BAKES = 2;

class FragmentDepwaitError extends Error {
  readonly depwait = true;
  constructor(message = "Waiting for local source media") {
    super(message);
    this.name = "FragmentDepwaitError";
  }
}

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
  if (windowClips.length > 0 && readyClips.length === 0) {
    throw new FragmentDepwaitError(
      missingIds.length > 0
        ? "Waiting for local source media"
        : "Fragment has no renderable video",
    );
  }
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

export async function readTimelinePreviewSnapshot(
  projectId: string,
): Promise<TimelinePreviewSnapshot | null> {
  const id = projectId.trim();
  if (!id) return null;
  try {
    return await invoke<TimelinePreviewSnapshot>(
      "library_read_timeline_preview_snapshot",
      { projectId: id },
    );
  } catch {
    return null;
  }
}

export type TimelinePreviewConfig = {
  encodeTag: string;
  fragmentDurationSec: number;
  fragmentFps: number;
  timescale: number;
};

export async function readTimelinePreviewConfig(): Promise<TimelinePreviewConfig> {
  return invoke<TimelinePreviewConfig>("library_read_timeline_preview_config");
}

/** Hold a disk path against prune/clear while MSE fetches it (F7). */
export { acquirePreviewLeases, releasePreviewLeases } from "../../playback/previewFragmentLeases";


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
  /** True while a manual rebuild is wiping the on-disk cache. */
  let pausingForRefresh = false;
  let bakeEpoch = 0;
  let error: string | null = null;
  let errorSource: "bake" | "playback" | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debounceGen = 0;
  let activeBakes = 0;
  const backoffTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const depwaitIndices = new Set<number>();
  const ready = new Map<number, ReadyTimelineFragment>();
  /** index → fingerprint currently encoding. Stale results are dropped. */
  const inflight = new Map<number, string>();
  /** index → earliest time we may retry after a bake failure. */
  const failureBackoffUntil = new Map<number, number>();
  /** Known-local asset ids — drives readiness bits in fingerprints. */
  let encodeTag = PREVIEW_ENCODE_TAG;
  void readTimelinePreviewConfig()
    .then((cfg) => {
      if (cfg.encodeTag.trim()) encodeTag = cfg.encodeTag.trim();
    })
    .catch(() => {
      /* fallback to bundled default */
    });

  const planWithTag = (
    clipInput: readonly TimelineClip[],
    aspect: string,
    qual: PreviewQuality,
    localIds?: Set<string> | null,
  ) =>
    planTimelineFragments(
      clipInput,
      aspect,
      undefined,
      qual,
      localIds,
      encodeTag,
    );
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

  const admissionIndices = (sec: number): number[] => {
    if (!plan || sec >= plan.durationSec - 1e-3) return [];
    const totalFrames = Math.round(plan.durationSec * 30);
    const index = fragmentIndexAtSec(sec, totalFrames);
    const out = [index];
    const next = index + 1;
    if (next < plan.fragments.length) out.push(next);
    return out;
  };

  const scheduleBackoffWake = (index: number, untilMs: number) => {
    const existing = backoffTimers.get(index);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, untilMs - Date.now());
    backoffTimers.set(
      index,
      setTimeout(() => {
        backoffTimers.delete(index);
        failureBackoffUntil.delete(index);
        scheduleJobs(true);
      }, delay),
    );
  };

  const clearBackoffTimer = (index: number) => {
    const timer = backoffTimers.get(index);
    if (timer) {
      clearTimeout(timer);
      backoffTimers.delete(index);
    }
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
    const nextPlan = planWithTag(
      clips,
      aspectRatio,
      quality,
      localAssetIds,
    );
    applyPlan(nextPlan);
    notify();
  };

  const reconcileSnapshot = async () => {
    const id = projectId.trim();
    if (!id || !plan) return;
    const snapshot = await readTimelinePreviewSnapshot(id);
    if (!snapshot || snapshot.encodeTag !== encodeTag) return;
    if (snapshot.aspectRatio !== aspectRatio || snapshot.quality !== quality) return;
    let changed = false;
    for (const entry of snapshot.fragments) {
      const spec = plan.fragments[entry.index];
      if (!spec || spec.fingerprint !== entry.fingerprint) continue;
      if (isReady(spec)) continue;
      ready.set(entry.index, {
        path: entry.path,
        index: entry.index,
        startSec: entry.startSec,
        durationSec: entry.durationSec,
        fingerprint: entry.fingerprint,
      });
      depwaitIndices.delete(entry.index);
      changed = true;
    }
    if (changed) notify();
  };

  const bakeOne = async (spec: TimelineFragmentSpec) => {
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
      clearBackoffTimer(spec.index);
      failureBackoffUntil.delete(spec.index);
      if (destroyed || epoch !== bakeEpoch) return;
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
      if (!plan) return;
      const current = plan.fragments[result.index];
      if (
        !current ||
        current.fingerprint !== result.fingerprint ||
        current.fingerprint !== spec.fingerprint
      ) {
        return;
      }
      ready.set(result.index, {
        path: result.path,
        index: result.index,
        startSec: result.startSec,
        durationSec: result.durationSec,
        fingerprint: result.fingerprint,
      });
      depwaitIndices.delete(result.index);
      if (errorSource === "bake") {
        error = null;
        errorSource = null;
      }
      notify();
    } catch (caught) {
      inflight.delete(spec.index);
      if (destroyed || epoch !== bakeEpoch) return;
      if (
        caught instanceof Error &&
        caught.message.includes("Stale preview bake")
      ) {
        scheduleJobs(true);
        notify();
        return;
      }
      const depwait =
        caught instanceof FragmentDepwaitError ||
        (caught instanceof Error &&
          (caught as { depwait?: boolean }).depwait === true);
      const until = Date.now() + BAKE_FAILURE_BACKOFF_MS;
      failureBackoffUntil.set(spec.index, until);
      scheduleBackoffWake(spec.index, until);
      if (depwait) {
        depwaitIndices.add(spec.index);
      } else {
        depwaitIndices.delete(spec.index);
      }
      if (!depwait) {
        error = caught instanceof Error ? caught.message : String(caught);
        errorSource = "bake";
      }
      notify();
    }
  };

  const maybePump = () => {
    if (destroyed || pausingForRefresh || !projectId.trim() || !plan) return;
    while (activeBakes < MAX_CONCURRENT_BAKES) {
      const spec = nextJob();
      if (!spec) break;
      activeBakes += 1;
      void bakeOne(spec).finally(() => {
        activeBakes = Math.max(0, activeBakes - 1);
        notify();
        maybePump();
      });
    }
  };

  const pump = () => {
    maybePump();
  };

  const scheduleJobs = (immediate: boolean) => {
    if (destroyed) return;
    if (debounceTimer != null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediate || debounceMs === 0) {
      pump();
      return;
    }
    const gen = ++debounceGen;
    debounceTimer = setTimeout(() => {
      if (destroyed || gen !== debounceGen) return;
      debounceTimer = null;
      pump();
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
      depwaitIndices.clear();
      localAssetIds = null;
    } else if (
      (nextAspect !== aspectRatio || nextQuality !== quality) &&
      projectId
    ) {
      void clearTimelineFragments(projectId).catch(() => {});
      ready.clear();
      inflight.clear();
      failureBackoffUntil.clear();
      depwaitIndices.clear();
    }
    projectId = nextId;
    clips = input.clips;
    aspectRatio = nextAspect;
    quality = nextQuality;
    const nextPlan = planWithTag(
      clips,
      aspectRatio,
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
    void reconcileSnapshot();
    if (!planChanged && spawn !== "now") return;
    if (spawn === "skip") return;
    scheduleJobs(spawn === "now");
  };

  return {
    setClips(input) {
      if (destroyed) return;
      commitClips(input, "debounce");
    },
    setPlayhead(sec, playing = false) {
      if (destroyed) return;
      playheadSec = sec;
      if (playing) {
        pump();
        return;
      }
      if (activeBakes > 0 || debounceTimer != null) return;
      if (nextJob()) pump();
    },
    demandPlayableWindow(sec) {
      if (destroyed) return;
      playheadSec = sec;
      if (debounceTimer != null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      // Touch admission indices so nextJob prioritizes them even while inflight.
      if (plan) {
        for (const index of admissionIndices(sec)) {
          const spec = plan.fragments[index];
          if (spec && !isReady(spec) && !inflight.has(index)) {
            /* priority comes from playheadIndex() via playheadSec above */
          }
        }
      }
      pump();
    },
    isDepwaitAt(sec) {
      if (!plan) return false;
      if (sec >= plan.durationSec - 1e-3) return false;
      const index = fragmentIndexAtSec(sec, Math.round(plan.durationSec * 30));
      return depwaitIndices.has(index);
    },
    invalidateFragmentAtPath(path) {
      if (destroyed) return;
      const target = path.trim();
      if (!target) return;
      let changed = false;
      for (const [index, rec] of ready) {
        if (rec.path !== target) continue;
        ready.delete(index);
        clearBackoffTimer(index);
        failureBackoffUntil.delete(index);
        changed = true;
      }
      if (!changed) return;
      if (errorSource === "playback") {
        error = null;
        errorSource = null;
      }
      notify();
      scheduleJobs(true);
    },
    setTimeline(input) {
      if (destroyed) return;
      playheadSec = input.playheadSec;
      commitClips(input, input.playing ? "now" : "debounce");
      if (input.playing) this.demandPlayableWindow(input.playheadSec);
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
        baking: activeBakes > 0 || inflight.size > 0 || pausingForRefresh,
        queued: queuedCount(),
        error,
        playheadReady:
          pastVideo || Boolean(plan && this.fragmentCovering(playheadSec)),
        depwait: depwaitIndices.size > 0,
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
      depwaitIndices.clear();
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
      for (const timer of backoffTimers.values()) clearTimeout(timer);
      backoffTimers.clear();
      listeners.clear();
      ready.clear();
      inflight.clear();
      failureBackoffUntil.clear();
      depwaitIndices.clear();
      plan = null;
    },
  };
}
