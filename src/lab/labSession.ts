/** Persist Lab UI / run state per project so you can leave and resume. */

import type { LabModuleId } from "../layouts/lab/labTypes";

const KEY_PREFIX = "parascene.labSession.v2.";
/** Older shape used a single shared progressLog / last across modules. */
const LEGACY_KEY_PREFIX = "parascene.labSession.v1.";

export type LabRunStatus = "idle" | "running" | "ok" | "failed";

export type LabLastResult = {
  summary: string;
  detail?: string;
  json?: unknown;
  playUrl?: string;
  playMediaType?: "audio" | "video";
  creationId?: string;
};

/** Vocals slice prepared in Vocals / slice — required input for a2v. */
export type LabVocalsSlice = {
  path: string;
  inSec: number;
  outSec: number;
  sourceAudioId: string;
  slicedAt: string;
};

/**
 * Uploaded audio clip for a vocals slice — gives the a2v provider a public URL.
 * Associated with the slice it came from (path + range) so it can be re-used
 * while that slice is unchanged, and cleaned up manually by the user.
 */
export type LabVocalsClip = {
  /** Parascene audio clip id (passed as `audio_clip_id` in create args). */
  clipId: string;
  /** Provider-fetchable public URL, when returned by the API. */
  audioUrl: string | null;
  /** Upload location: the local slice this clip was uploaded from. */
  slicePath: string;
  inSec: number;
  outSec: number;
  sourceAudioId: string;
  uploadedAt: string;
};

/** True when an uploaded clip still matches the current vocals slice. */
export function vocalsClipMatchesSlice(
  clip: LabVocalsClip | null,
  slice: LabVocalsSlice | null,
): boolean {
  return Boolean(
    clip &&
      slice &&
      clip.slicePath === slice.path &&
      clip.inSec === slice.inSec &&
      clip.outSec === slice.outSec,
  );
}

export type LabModuleProgress = {
  status: LabRunStatus;
  note: string;
};

export type LabSessionSnapshot = {
  moduleId: LabModuleId;
  /** Per-module badge in the left selector */
  moduleProgress: Partial<Record<LabModuleId, LabModuleProgress>>;
  /** Live steps under the action button — scoped per module */
  progressLogByModule: Partial<Record<LabModuleId, string[]>>;
  /** Last result footer — scoped per module */
  lastByModule: Partial<Record<LabModuleId, LabLastResult>>;
  /** Vocals slice from Vocals / slice — pipeline input for a2v */
  vocalsSlice: LabVocalsSlice | null;
  /** Uploaded clip for the current vocals slice — provides a2v's public URL */
  vocalsClip: LabVocalsClip | null;
  /** In-flight job so we can resume polling after remount */
  activeJob: {
    moduleId: LabModuleId;
    phase: string;
    startedAt: string;
    /** Durable Rust generation job UUID (source of truth for resume). */
    backendJobId?: string | null;
    /** Creation currently waiting on Parascene (mirrored from job checkpoint). */
    pendingCreationId?: string | null;
    /** How to file the pending creation after resume wait */
    pendingMediaType?: "image" | "video" | null;
    /** Ensure groups checkpoint (survives leave / remount) */
    imagesGroupId?: string | null;
    videosGroupId?: string | null;
  } | null;
};

const ALL_MODULE_IDS: LabModuleId[] = [
  "groups",
  "create",
  "seeds",
  "isolate",
  "a2v",
  "extend",
  "mutate",
  "openai",
  "align",
  "propose",
];

export function emptyLabSession(moduleId: LabModuleId = "groups"): LabSessionSnapshot {
  return {
    moduleId,
    moduleProgress: {},
    progressLogByModule: {},
    lastByModule: {},
    vocalsSlice: null,
    vocalsClip: null,
    activeJob: null,
  };
}

function isModuleId(value: unknown): value is LabModuleId {
  return typeof value === "string" && ALL_MODULE_IDS.includes(value as LabModuleId);
}

/** True when a last-result blob clearly belongs to Project groups cleanup/ensure. */
function looksLikeGroupsResult(last: LabLastResult): boolean {
  const blob = `${last.summary}\n${last.detail ?? ""}\n${
    last.json != null ? JSON.stringify(last.json) : ""
  }`.toLowerCase();
  return (
    blob.includes("cleaned up") ||
    blob.includes("cleanup finished") ||
    blob.includes("deleting ") ||
    blob.includes("images group") ||
    blob.includes("videos group") ||
    blob.includes("ensure") ||
    blob.includes("deletedids")
  );
}

/**
 * Place a legacy shared `last` on the module that owns it.
 * Prefer matching moduleProgress notes; never invent ownership from the
 * currently-viewed moduleId (that caused cleanup to stick on Create).
 */
function placeLegacyLast(
  last: LabLastResult,
  moduleProgress: Partial<Record<LabModuleId, LabModuleProgress>>,
): Partial<Record<LabModuleId, LabLastResult>> {
  for (const id of ALL_MODULE_IDS) {
    const prog = moduleProgress[id];
    if (
      prog &&
      (prog.status === "ok" || prog.status === "failed") &&
      prog.note === last.summary
    ) {
      return { [id]: last };
    }
  }
  if (looksLikeGroupsResult(last)) return { groups: last };
  // Unknown shared last — drop rather than pin to the wrong screen.
  return {};
}

function placeLegacyLog(
  log: string[],
  moduleProgress: Partial<Record<LabModuleId, LabModuleProgress>>,
  activeJob: LabSessionSnapshot["activeJob"],
): Partial<Record<LabModuleId, string[]>> {
  if (log.length === 0) return {};
  if (activeJob?.moduleId) return { [activeJob.moduleId]: log };
  for (const id of ALL_MODULE_IDS) {
    const prog = moduleProgress[id];
    if (prog && (prog.status === "ok" || prog.status === "failed" || prog.status === "running")) {
      return { [id]: log };
    }
  }
  const joined = log.join("\n").toLowerCase();
  if (
    joined.includes("deleting ") ||
    joined.includes("cleanup") ||
    joined.includes("images:") ||
    joined.includes("videos:")
  ) {
    return { groups: log };
  }
  return {};
}

/** Fix results that were wrongly copied onto Create/etc. after the shared-last era. */
export function sanitizeLabSession(snapshot: LabSessionSnapshot): LabSessionSnapshot {
  const lastByModule = { ...snapshot.lastByModule };
  const progressLogByModule = { ...snapshot.progressLogByModule };
  const groupsLast = lastByModule.groups;
  let changed = false;
  const vocalsSlice =
    snapshot.vocalsSlice &&
    typeof snapshot.vocalsSlice === "object" &&
    typeof snapshot.vocalsSlice.path === "string"
      ? snapshot.vocalsSlice
      : null;
  if (vocalsSlice !== snapshot.vocalsSlice) changed = true;
  const vocalsClip =
    snapshot.vocalsClip &&
    typeof snapshot.vocalsClip === "object" &&
    typeof snapshot.vocalsClip.clipId === "string"
      ? snapshot.vocalsClip
      : null;
  if (vocalsClip !== snapshot.vocalsClip) changed = true;

  for (const id of ["create", "mutate", "a2v", "seeds", "isolate", "extend", "openai", "align", "propose"] as const) {
    const last = lastByModule[id];
    if (!last) continue;
    if (looksLikeGroupsResult(last)) {
      if (!groupsLast) lastByModule.groups = last;
      delete lastByModule[id];
      changed = true;
    }
  }

  for (const id of ["create", "mutate", "a2v", "seeds", "isolate", "extend", "openai", "align", "propose"] as const) {
    const log = progressLogByModule[id];
    if (!log?.length) continue;
    const joined = log.join("\n").toLowerCase();
    if (
      joined.includes("deleting ") ||
      joined.includes("cleanup finished") ||
      joined.includes("cleaned up")
    ) {
      if (!(progressLogByModule.groups?.length)) {
        progressLogByModule.groups = log;
      }
      delete progressLogByModule[id];
      changed = true;
    }
  }

  if (!changed) return snapshot;
  return {
    ...snapshot,
    lastByModule,
    progressLogByModule,
    vocalsSlice,
    vocalsClip,
  };
}

function migrateLegacy(raw: string): LabSessionSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as {
      moduleId?: unknown;
      moduleProgress?: LabSessionSnapshot["moduleProgress"];
      progressLog?: unknown;
      last?: unknown;
      activeJob?: LabSessionSnapshot["activeJob"];
    };
    const moduleId = isModuleId(parsed.moduleId) ? parsed.moduleId : "groups";
    const base = emptyLabSession(moduleId);
    const moduleProgress =
      parsed.moduleProgress && typeof parsed.moduleProgress === "object"
        ? parsed.moduleProgress
        : {};
    const activeJob =
      parsed.activeJob && typeof parsed.activeJob === "object"
        ? parsed.activeJob
        : null;
    const log = Array.isArray(parsed.progressLog)
      ? parsed.progressLog.filter((x): x is string => typeof x === "string")
      : [];
    const last =
      parsed.last && typeof parsed.last === "object"
        ? (parsed.last as LabLastResult)
        : null;
    return sanitizeLabSession({
      ...base,
      moduleProgress,
      progressLogByModule: placeLegacyLog(log, moduleProgress, activeJob),
      lastByModule: last ? placeLegacyLast(last, moduleProgress) : {},
      activeJob,
    });
  } catch {
    return null;
  }
}

export function loadLabSession(projectId: string): LabSessionSnapshot {
  if (!projectId) return emptyLabSession();
  try {
    const raw = localStorage.getItem(KEY_PREFIX + projectId);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LabSessionSnapshot> & {
        progressLog?: unknown;
        last?: unknown;
      };
      const moduleId = isModuleId(parsed.moduleId) ? parsed.moduleId : "groups";
      const base = emptyLabSession(moduleId);
      const moduleProgress =
        parsed.moduleProgress && typeof parsed.moduleProgress === "object"
          ? parsed.moduleProgress
          : {};
      const activeJob =
        parsed.activeJob && typeof parsed.activeJob === "object"
          ? parsed.activeJob
          : null;

      let progressLogByModule =
        parsed.progressLogByModule &&
        typeof parsed.progressLogByModule === "object"
          ? { ...parsed.progressLogByModule }
          : {};
      let lastByModule =
        parsed.lastByModule && typeof parsed.lastByModule === "object"
          ? { ...parsed.lastByModule }
          : {};
      const vocalsSlice =
        parsed.vocalsSlice &&
        typeof parsed.vocalsSlice === "object" &&
        typeof (parsed.vocalsSlice as LabVocalsSlice).path === "string"
          ? (parsed.vocalsSlice as LabVocalsSlice)
          : null;
      const vocalsClip =
        parsed.vocalsClip &&
        typeof parsed.vocalsClip === "object" &&
        typeof (parsed.vocalsClip as LabVocalsClip).clipId === "string"
          ? (parsed.vocalsClip as LabVocalsClip)
          : null;

      if (
        Object.keys(progressLogByModule).length === 0 &&
        Array.isArray(parsed.progressLog)
      ) {
        const log = parsed.progressLog.filter(
          (x): x is string => typeof x === "string",
        );
        progressLogByModule = placeLegacyLog(log, moduleProgress, activeJob);
      }
      if (
        Object.keys(lastByModule).length === 0 &&
        parsed.last &&
        typeof parsed.last === "object"
      ) {
        lastByModule = placeLegacyLast(
          parsed.last as LabLastResult,
          moduleProgress,
        );
      }

      return sanitizeLabSession({
        ...base,
        moduleProgress,
        progressLogByModule,
        lastByModule,
        vocalsSlice,
        vocalsClip,
        activeJob,
      });
    }

    const legacy = localStorage.getItem(LEGACY_KEY_PREFIX + projectId);
    if (legacy) {
      const migrated = migrateLegacy(legacy);
      if (migrated) {
        saveLabSession(projectId, migrated);
        try {
          localStorage.removeItem(LEGACY_KEY_PREFIX + projectId);
        } catch {
          /* ignore */
        }
        return migrated;
      }
    }
    return emptyLabSession();
  } catch {
    return emptyLabSession();
  }
}

export function saveLabSession(
  projectId: string,
  snapshot: LabSessionSnapshot,
): void {
  if (!projectId) return;
  try {
    localStorage.setItem(KEY_PREFIX + projectId, JSON.stringify(snapshot));
  } catch {
    /* ignore quota */
  }
}
