import {
  clampSensitivity,
  normalizeSlideshowMode,
  type AddAssetDraft,
  type AlignedLyricLine,
  type LyricAlignment,
  type LyricTranscript,
  type Project,
  type ProjectAsset,
  type SlideshowRecipe,
  type StoryboardGenerationPlan,
  type StoryboardProposal,
  type TimelineClip,
} from "./types";
import {
  enforceNonOverlappingAlignedLines,
  isInaudibleLyricText,
  reconcileAlignedLinesFromScript,
} from "../lab/lyricAlign";
import {
  normalizeStoryboardProposal,
} from "./storyboardNormalize";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  type ProjectAspectRatio,
} from "./aspectRatios";
import { normalizeAddAssetGeneration } from "./desktopAddAssetGeneration";
import {
  compositionInternalCreationIds,
  normalizeStillWorkstream,
  normalizeStillWorkstreams,
  type StillWorkstream,
} from "./stillWorkstream";
import { normalizeProjectTitle } from "./projectTitle";

/** Parse draft.replicateTweaks without importing editor modules (avoids init cycles). */
function parseReplicateVideoTweaks(
  value: unknown,
): NonNullable<AddAssetDraft["replicateTweaks"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: NonNullable<AddAssetDraft["replicateTweaks"]> = {};
  if (typeof row.resolution === "string" && row.resolution.trim()) {
    out.resolution = row.resolution.trim();
  }
  if (typeof row.mode === "string" && row.mode.trim()) {
    out.mode = row.mode.trim();
  }
  if (typeof row.generateAudio === "boolean") {
    out.generateAudio = row.generateAudio;
  }
  if (typeof row.negativePrompt === "string") {
    out.negativePrompt = row.negativePrompt;
  }
  if (typeof row.seed === "number" && Number.isFinite(row.seed)) {
    out.seed = Math.floor(row.seed);
  } else if (row.seed === null) {
    out.seed = null;
  }
  if (
    typeof row.characterOrientation === "string" &&
    row.characterOrientation.trim()
  ) {
    out.characterOrientation = row.characterOrientation.trim();
  }
  if (typeof row.keepOriginalSound === "boolean") {
    out.keepOriginalSound = row.keepOriginalSound;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
import {
  isProjectLookId,
  normalizeProjectLooks,
  PROJECT_LOOK_IDS,
  type ProjectLookId,
  type ProjectLooks,
} from "./looks";

export type StoredProject = {
  schemaVersion?: 2;
  id: string;
  title: string;
  creationIds: string[];
  /** Legacy attachment ids, read only during reconciliation; omitted → []. */
  folderIds?: string[];
  /**
   * Legacy explicit binding used only as open-time reconciliation evidence.
   * Ready projects clear it; omitted on older projects → null.
   */
  boundFolderId?: string | null;
  /** Still composition workstreams; omitted → []. */
  stillWorkstreams?: import("./stillWorkstream").StillWorkstream[];
  /** Creative output frame; omitted on older stored projects → default. */
  aspectRatio?: ProjectAspectRatio;
  /** Export-time Looks; omitted on older stored projects → {}. */
  looks?: ProjectLooks;
  /** Editor timeline clips; omitted on older stored projects → []. */
  timeline?: TimelineClip[];
  /** Selected timeline clip in the editor; omitted → null. */
  selectedTimelineClipId?: string | null;
  /** Selected asset in the editor assets pane; omitted → null. */
  selectedAssetId?: string | null;
  /**
   * Source-preview staging draft persisted across page switches; omitted → null.
   * Normalized by editor staging helpers on read.
   */
  pendingStagedDraft?: unknown | null;
  /** Timeline zoom (0.5–3); omitted → 1. */
  timelineZoom?: number;
  /** Preview follows timeline; omitted → false. */
  timelineMonitorActive?: boolean;
  /** Timeline playhead seconds; omitted → 0. */
  timelinePlayheadSec?: number;
  /** Parascene Images group creation id; omitted → null. */
  imagesGroupId?: string | null;
  /** Parascene Videos group creation id; omitted → null. */
  videosGroupId?: string | null;
  /** Lab still prompt for Project groups; omitted → null (use Lab default). */
  labStillPrompt?: string | null;
  /** Lab animate prompt for Project groups; omitted → null (use Lab default). */
  labAnimatePrompt?: string | null;
  /** Preferred main song creation id; omitted → null. */
  mainAudioCreationId?: string | null;
  /** Lab lyric align output; omitted → null. */
  lyricAlignment?: LyricAlignment | null;
  /** Lab MV storyboard; omitted → null. */
  storyboardProposal?: StoryboardProposal | null;
  /** MV Concept seed prompt; omitted → null. */
  labStoryboardDirection?: string | null;
  updatedAt: string;
  /** Opaque project-document revision; distinct from Library/cloud revisions. */
  documentRevision?: string;
  /** New-project setup lifecycle. Legacy projects omit this until reconciled or intentionally opened unbound. */
  lifecycle?: "provisioning" | "ready" | "repair-needed" | "legacy";
  /**
   * Sticky chooser badge when open was blocked on folder layout.
   * Cleared only after a successful project-folder open or intentional legacy open.
   */
  folderSetupIssue?: "blocked" | null;
};

export const PROJECTS_STORAGE_KEY = "parascene.projects.v1";
export const DEFAULT_TIMELINE_ZOOM = 1;
export const TIMELINE_ZOOM_MIN = 0.5;
export const TIMELINE_ZOOM_MAX = 3;

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function loadStoredProjects(): StoredProject[] {
  try {
    const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: StoredProject[] = [];
    for (const row of parsed) {
      if (!isStoredProject(row)) continue;
      try {
        out.push(normalizeStoredProject(row));
      } catch (error) {
        console.error(
          "[loadStoredProjects] Skipping corrupt project",
          row.id,
          error,
        );
      }
    }
    return out;
  } catch (error) {
    console.error("[loadStoredProjects] Failed to read projects", error);
    return [];
  }
}

export type CorruptStoredProject = {
  id: string;
  title: string;
  error: string;
  raw: unknown;
};

export type PartitionedStoredProjects = {
  projects: StoredProject[];
  corrupt: CorruptStoredProject[];
  /** Storage order of every row id (healthy + corrupt) for passthrough saves. */
  orderedIds: string[];
};

function readStoredProjectsArray(): unknown[] {
  const raw = localStorage.getItem(PROJECTS_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Stored projects could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Stored projects are not an array");
  }
  return parsed;
}

function tryStrictStoredProject(
  row: unknown,
  index: number,
):
  | { ok: true; project: StoredProject }
  | { ok: false; corrupt: CorruptStoredProject } {
  if (!isStoredProject(row)) {
    return {
      ok: false,
      corrupt: {
        id: `malformed-row-${index + 1}`,
        title: "Malformed project",
        error: `Stored project ${index + 1} is malformed`,
        raw: row,
      },
    };
  }
  try {
    const normalized = normalizeStoredProject(row);
    assertStrictProjectSafetyShape(row, normalized);
    return { ok: true, project: normalized };
  } catch (error) {
    return {
      ok: false,
      corrupt: {
        id: row.id,
        title: row.title.trim() || "Untitled project",
        error: error instanceof Error ? error.message : String(error),
        raw: row,
      },
    };
  }
}

/**
 * Strict-check each stored row independently. Corrupt siblings stay isolated
 * so healthy projects can open and mutate.
 */
export function partitionStoredProjects(): PartitionedStoredProjects {
  const parsed = readStoredProjectsArray();
  const projects: StoredProject[] = [];
  const corrupt: CorruptStoredProject[] = [];
  const orderedIds: string[] = [];
  parsed.forEach((row, index) => {
    const result = tryStrictStoredProject(row, index);
    if (result.ok) {
      projects.push(result.project);
      orderedIds.push(result.project.id);
    } else {
      corrupt.push(result.corrupt);
      orderedIds.push(result.corrupt.id);
    }
  });
  return { projects, corrupt, orderedIds };
}

/** Strict loader for safety-sensitive operations. Never drops malformed rows. */
export function loadStoredProjectsStrict(): StoredProject[] {
  const { projects, corrupt } = partitionStoredProjects();
  if (corrupt.length > 0) {
    const first = corrupt[0];
    throw new Error(`Stored project ${first.id} is corrupt: ${first.error}`);
  }
  return projects;
}

/** Strict-load a single project; sibling corruption does not throw. */
export function loadStoredProjectStrict(id: string): StoredProject {
  const { projects, corrupt } = partitionStoredProjects();
  const found = projects.find((project) => project.id === id);
  if (found) return found;
  const bad = corrupt.find((row) => row.id === id);
  if (bad) {
    throw new Error(`Stored project ${bad.id} is corrupt: ${bad.error}`);
  }
  throw new Error(`Stored project ${id} was not found`);
}

export function findCorruptStoredProject(
  id: string,
): CorruptStoredProject | null {
  return (
    partitionStoredProjects().corrupt.find((row) => row.id === id) ?? null
  );
}

/**
 * Drop timeline clips that fail normalization, then re-validate. Used only
 * after explicit user confirmation — never on ambient load.
 */
export function repairMalformedTimelineClips(raw: unknown): StoredProject {
  if (!isStoredProject(raw)) {
    throw new Error("Cannot repair: project row is malformed");
  }
  const record = raw as unknown as Record<string, unknown>;
  if (record.timeline !== undefined && !Array.isArray(record.timeline)) {
    throw new Error("Cannot repair: timeline is not an array");
  }
  const repairedRaw: StoredProject = {
    ...raw,
    timeline: Array.isArray(record.timeline)
      ? normalizeStoredTimeline(record.timeline)
      : raw.timeline,
  };
  const normalized = normalizeStoredProject(repairedRaw);
  assertStrictProjectSafetyShape(repairedRaw, normalized);
  return {
    ...normalized,
    schemaVersion: 2,
    documentRevision: nextProjectDocumentRevision(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Write healthy projects while leaving corrupt raw rows in place (unless a
 * healthy project with the same id replaces them — e.g. after repair).
 */
export function saveStoredProjectsPreservingCorrupt(
  projects: StoredProject[],
  corrupt: readonly CorruptStoredProject[],
  orderedIds: readonly string[],
  options?: { allowEmpty?: boolean },
): void {
  const healthyById = new Map(projects.map((project) => [project.id, project]));
  const corruptById = new Map(corrupt.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const out: unknown[] = [];

  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    const healthy = healthyById.get(id);
    if (healthy) {
      out.push(healthy);
      seen.add(id);
      continue;
    }
    const bad = corruptById.get(id);
    if (bad) {
      out.push(bad.raw);
      seen.add(id);
    }
  }

  for (const project of projects) {
    if (seen.has(project.id)) continue;
    out.push(project);
    seen.add(project.id);
  }

  if (out.length === 0 && options?.allowEmpty !== true) {
    const existing = localStorage.getItem(PROJECTS_STORAGE_KEY);
    if (existing && existing !== "[]") {
      console.error(
        "[saveStoredProjectsPreservingCorrupt] Refusing to overwrite non-empty projects with []",
      );
      return;
    }
  }
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(out));
}

/** Remove one project document (healthy or corrupt). Allows an empty project list. */
export function deleteStoredProjectDocument(id: string): void {
  const target = id.trim();
  if (!target) return;
  const { projects, corrupt, orderedIds } = partitionStoredProjects();
  saveStoredProjectsPreservingCorrupt(
    projects.filter((project) => project.id !== target),
    corrupt.filter((row) => row.id !== target),
    orderedIds.filter((orderedId) => orderedId !== target),
    { allowEmpty: true },
  );
}

function strictReferenceIds(value: StoredProject): Set<string> {
  const project = value as unknown as Record<string, unknown>;
  const ids = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate === "string" && candidate.trim()) {
      ids.add(candidate.trim());
    }
  };
  const object = (candidate: unknown): Record<string, unknown> | null =>
    candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>)
      : null;

  if (Array.isArray(project.timeline)) {
    for (const rawClip of project.timeline) {
      const clip = object(rawClip);
      if (!clip) continue;
      add(clip.assetId);
      const slideshow = object(clip.slideshow);
      if (Array.isArray(slideshow?.imageAssetIds)) {
        for (const id of slideshow.imageAssetIds) add(id);
      }
      add(slideshow?.audioAssetId);
      const draft = object(clip.addAssetDraft);
      const generation = object(clip.addAssetGeneration);
      add(draft?.startFrameAssetId);
      add(generation?.startFrameAssetId);
      add(generation?.creationId);
    }
  }

  if (Array.isArray(project.stillWorkstreams)) {
    for (const rawStream of project.stillWorkstreams) {
      const stream = object(rawStream);
      if (!stream) continue;
      if (Array.isArray(stream.memberIds)) {
        for (const id of stream.memberIds) add(id);
      }
      if (Array.isArray(stream.nodes)) {
        for (const rawNode of stream.nodes) {
          const node = object(rawNode);
          if (!node || node.status === "discarded") continue;
          add(node.creationId);
        }
      }
    }
  }

  add(project.mainAudioCreationId);
  const lyric = object(project.lyricAlignment);
  add(lyric?.sourceAudioCreationId);
  const storyboard = object(project.storyboardProposal);
  add(storyboard?.sourceAudioCreationId);
  const generationPlan = object(storyboard?.generationPlan);
  if (Array.isArray(generationPlan?.steps)) {
    for (const rawStep of generationPlan.steps) {
      const step = object(rawStep);
      if (!step) continue;
      add(step.creationId);
      add(object(step.stillSource)?.creationId);
    }
  }
  add(project.imagesGroupId);
  add(project.videosGroupId);
  return ids;
}

/**
 * Safety-sensitive loads may normalize legacy values, but they may never
 * normalize away a timeline/composition reference. Any unreadable nested row
 * blocks destructive Library operations until the project is repaired.
 */
function assertStrictProjectSafetyShape(
  raw: StoredProject,
  normalized: StoredProject,
): void {
  const project = raw as unknown as Record<string, unknown>;
  if (project.timeline !== undefined) {
    if (!Array.isArray(project.timeline)) {
      throw new Error("timeline is not an array");
    }
    if (normalizeStoredTimeline(project.timeline).length !== project.timeline.length) {
      throw new Error("timeline contains a malformed clip");
    }
  }

  if (project.stillWorkstreams !== undefined) {
    if (!Array.isArray(project.stillWorkstreams)) {
      throw new Error("compositions are not an array");
    }
    const normalizedStreams = normalizeStillWorkstreams(project.stillWorkstreams);
    if (normalizedStreams.length !== project.stillWorkstreams.length) {
      throw new Error("compositions contain a malformed row");
    }
    project.stillWorkstreams.forEach((candidate, index) => {
      const stream = candidate as Record<string, unknown>;
      if (stream.nodes !== undefined && !Array.isArray(stream.nodes)) {
        throw new Error(`composition ${index + 1} nodes are not an array`);
      }
      if (
        Array.isArray(stream.nodes) &&
        normalizedStreams[index]?.nodes.length !== stream.nodes.length
      ) {
        throw new Error(`composition ${index + 1} contains a malformed node`);
      }
      if (stream.memberIds !== undefined && !Array.isArray(stream.memberIds)) {
        throw new Error(`composition ${index + 1} members are not an array`);
      }
    });
  }

  if (
    project.lyricAlignment !== undefined &&
    project.lyricAlignment !== null &&
    normalizeLyricAlignment(project.lyricAlignment) === null
  ) {
    throw new Error("lyric alignment is malformed");
  }
  if (
    project.storyboardProposal !== undefined &&
    project.storyboardProposal !== null &&
    normalizeStoryboardProposal(project.storyboardProposal) === null
  ) {
    throw new Error("storyboard is malformed");
  }

  const normalizedIds = strictReferenceIds(normalized);
  const omittedIds = [...strictReferenceIds(raw)].filter(
    (id) => !normalizedIds.has(id),
  );
  if (omittedIds.length > 0) {
    throw new Error(
      `normalization would omit referenced creation(s): ${omittedIds.join(", ")}`,
    );
  }
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.title === "string" &&
    Array.isArray(p.creationIds) &&
    p.creationIds.every((id) => typeof id === "string") &&
    typeof p.updatedAt === "string"
  );
}

export function normalizeTimelineClip(value: unknown): TimelineClip | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.label !== "string") return null;
  const startSec = Number(c.startSec);
  const endSec = Number(c.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }
  const kind =
    c.kind === "video" ||
    c.kind === "image" ||
    c.kind === "audio" ||
    c.kind === "slideshow"
      ? c.kind
      : undefined;
  const lane =
    c.lane === "video" || c.lane === "audio"
      ? c.lane
      : kind === "audio"
        ? "audio"
        : "video";
  const resolvedKind =
    kind ?? (lane === "audio" ? ("audio" as const) : undefined);
  const inSec = Number(c.inSec);
  const outSec = Number(c.outSec);
  const slideshow =
    resolvedKind === "slideshow"
      ? normalizeStoredSlideshow(c.slideshow)
      : undefined;
  if (resolvedKind === "slideshow" && !slideshow) return null;
  const bakeKey = typeof c.bakeKey === "string" ? c.bakeKey : null;
  const bakePath =
    typeof c.bakePath === "string" && c.bakePath.trim()
      ? c.bakePath.trim()
      : null;
  return {
    id: c.id,
    label: c.label,
    startSec,
    endSec,
    assetId: typeof c.assetId === "string" ? c.assetId : undefined,
    thumbUrl: typeof c.thumbUrl === "string" ? c.thumbUrl : null,
    lane,
    kind: resolvedKind,
    inSec: Number.isFinite(inSec) ? inSec : undefined,
    outSec: Number.isFinite(outSec) ? outSec : undefined,
    includeAudio:
      resolvedKind === "audio" || resolvedKind === "slideshow"
        ? false
        : typeof c.includeAudio === "boolean"
          ? c.includeAudio
          : undefined,
    linkedVideoClipId:
      typeof c.linkedVideoClipId === "string" && c.linkedVideoClipId.trim()
        ? c.linkedVideoClipId.trim()
        : undefined,
    reverse: typeof c.reverse === "boolean" ? c.reverse : undefined,
    transform:
      c.transform === "kenBurns"
        ? "kenBurns"
        : c.transform === "hold"
          ? "hold"
          : undefined,
    framing:
      c.framing === "fit" || c.framing === "fill" || c.framing === "stretch"
        ? c.framing
        : undefined,
    zoom: Number.isFinite(Number(c.zoom))
      ? Math.min(4, Math.max(1, Number(c.zoom)))
      : undefined,
    centerX: Number.isFinite(Number(c.centerX))
      ? Math.min(50, Math.max(-50, Number(c.centerX)))
      : undefined,
    centerY: Number.isFinite(Number(c.centerY))
      ? Math.min(50, Math.max(-50, Number(c.centerY)))
      : undefined,
    slideshow,
    bakeKey,
    bakePath,
    isAddAssetPlaceholder:
      c.isAddAssetPlaceholder === true ? true : undefined,
    timelineLocked:
      resolvedKind === "audio" || resolvedKind === "image"
        ? undefined
        : c.timelineLocked === true
          ? true
          : undefined,
    speed: (() => {
      const s = Number(c.speed);
      if (!Number.isFinite(s) || Math.abs(s - 1) < 0.001) return undefined;
      return Math.min(8, Math.max(0.25, s));
    })(),
    extendPingPong: c.extendPingPong === true ? true : undefined,
    extendSourceSpanSec:
      Number.isFinite(Number(c.extendSourceSpanSec)) &&
      Number(c.extendSourceSpanSec) > 0
        ? Math.max(0.1, Number(c.extendSourceSpanSec))
        : undefined,
    extendBakeKey:
      typeof c.extendBakeKey === "string" && c.extendBakeKey.trim()
        ? c.extendBakeKey.trim()
        : null,
    extendBakePath:
      typeof c.extendBakePath === "string" && c.extendBakePath.trim()
        ? c.extendBakePath.trim()
        : null,
    extendBakeCoverSec:
      Number.isFinite(Number(c.extendBakeCoverSec)) &&
      Number(c.extendBakeCoverSec) > 0
        ? Math.max(0.1, Number(c.extendBakeCoverSec))
        : undefined,
    addAssetDraft: normalizeAddAssetDraft(c.addAssetDraft),
    addAssetGeneration: normalizeAddAssetGeneration(c.addAssetGeneration),
  };
}

function normalizeAddAssetDraft(value: unknown): AddAssetDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const prompt =
    typeof row.prompt === "string" ? row.prompt : undefined;
  const audioMode =
    row.audioMode === "full_mix"
      ? "full_mix"
      : row.audioMode === "vocals"
        ? "vocals"
        : row.audioMode === "none"
          ? "none"
          : undefined;
  const continuityMode =
    row.continuityMode === "first_last"
      ? "first_last"
      : row.continuityMode === "motion_match"
        ? "motion_match"
        : row.continuityMode === "start_frame"
          ? "start_frame"
          : row.continuityMode === "none"
            ? "none"
            : undefined;
  const blueModel =
    row.blueModel === "wan" || row.blueModel === "ltx"
      ? row.blueModel
      : undefined;
  const provider =
    typeof row.provider === "string" && row.provider.trim()
      ? row.provider.trim()
      : undefined;
  const methodId =
    typeof row.methodId === "string" && row.methodId.trim()
      ? row.methodId.trim()
      : undefined;
  const replicateModel =
    typeof row.replicateModel === "string" && row.replicateModel.trim()
      ? row.replicateModel.trim()
      : undefined;
  const useNearestDuration = row.useNearestDuration === true ? true : undefined;
  const lastError =
    typeof row.lastError === "string" && row.lastError.trim()
      ? row.lastError.trim()
      : undefined;
  const replicatePredictionId =
    typeof row.replicatePredictionId === "string" &&
    row.replicatePredictionId.trim()
      ? row.replicatePredictionId.trim()
      : undefined;
  const replicateTweaks = parseReplicateVideoTweaks(row.replicateTweaks);
  const startFrameAssetId =
    typeof row.startFrameAssetId === "string" && row.startFrameAssetId.trim()
      ? row.startFrameAssetId.trim()
      : undefined;
  const startFrameFraming =
    row.startFrameFraming === "fill" || row.startFrameFraming === "stretch"
      ? row.startFrameFraming
      : row.startFrameFraming === "fit"
        ? "fit"
        : undefined;
  if (
    prompt === undefined &&
    audioMode === undefined &&
    continuityMode === undefined &&
    blueModel === undefined &&
    provider === undefined &&
    methodId === undefined &&
    replicateModel === undefined &&
    useNearestDuration === undefined &&
    lastError === undefined &&
    replicatePredictionId === undefined &&
    replicateTweaks === undefined &&
    startFrameAssetId === undefined &&
    startFrameFraming === undefined
  ) {
    return undefined;
  }
  return {
    prompt,
    audioMode,
    continuityMode,
    blueModel,
    provider,
    methodId,
    replicateModel,
    useNearestDuration,
    lastError,
    replicatePredictionId,
    replicateTweaks,
    startFrameAssetId,
    startFrameFraming,
  };
}

function normalizeStoredSlideshow(value: unknown): SlideshowRecipe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.imageAssetIds)) return undefined;
  const imageAssetIds = s.imageAssetIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter(Boolean);
  if (imageAssetIds.length < 1) return undefined;
  // New slideshows still require 2+ images in the editor. Persist 1-image
  // recipes so legacy/corrupt rows open instead of failing the whole project.
  // Legacy projects stored mode:"random" (even timing + shuffle).
  const legacyRandom = s.mode === "random";
  const mode = normalizeSlideshowMode(s.mode);
  const random = s.random === true || legacyRandom;
  const recipe: SlideshowRecipe = { imageAssetIds, mode };
  if (random) recipe.random = true;
  const seed = Number(s.seed);
  if (random && Number.isFinite(seed)) {
    recipe.seed = Math.trunc(seed) >>> 0;
  }
  if (typeof s.audioAssetId === "string" && s.audioAssetId.trim()) {
    recipe.audioAssetId = s.audioAssetId.trim();
  }
  const audioInSec = Number(s.audioInSec);
  const audioOutSec = Number(s.audioOutSec);
  const audioStartSec = Number(s.audioStartSec);
  const audioEndSec = Number(s.audioEndSec);
  if (Number.isFinite(audioInSec)) recipe.audioInSec = audioInSec;
  if (Number.isFinite(audioOutSec)) recipe.audioOutSec = audioOutSec;
  if (Number.isFinite(audioStartSec)) recipe.audioStartSec = audioStartSec;
  if (Number.isFinite(audioEndSec)) recipe.audioEndSec = audioEndSec;
  const sensitivity = clampSensitivity(s.sensitivity);
  if (sensitivity !== undefined) recipe.sensitivity = sensitivity;
  return recipe;
}

export function normalizeStoredTimeline(value: unknown): TimelineClip[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeTimelineClip)
    .filter((c): c is TimelineClip => c !== null);
}

export function normalizeTimelineZoom(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TIMELINE_ZOOM;
  const clamped = Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, n));
  return Math.round(clamped * 4) / 4;
}

export function normalizeTimelineMonitorActive(value: unknown): boolean {
  return value === true;
}

export function normalizeTimelinePlayheadSec(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeSelectedTimelineClipId(
  value: unknown,
  timeline: TimelineClip[],
): string | null {
  if (typeof value !== "string" || !value) return null;
  return timeline.some((c) => c.id === value) ? value : null;
}

function normalizeSelectedAssetId(
  value: unknown,
  creationIds: string[],
): string | null {
  if (typeof value !== "string" || !value) return null;
  return creationIds.includes(value) ? value : null;
}

export function normalizeFolderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeStoredProject(project: StoredProject): StoredProject {
  const stillWorkstreams = normalizeStillWorkstreams(project.stillWorkstreams);
  const creationIds = [...new Set(project.creationIds.map((id) => id.trim()).filter(Boolean))];
  const aspectRatio = isProjectAspectRatio(project.aspectRatio)
    ? project.aspectRatio
    : DEFAULT_PROJECT_ASPECT_RATIO;
  const timeline = normalizeStoredTimeline(project.timeline);
  const selectedTimelineClipId = normalizeSelectedTimelineClipId(
    project.selectedTimelineClipId,
    timeline,
  );
  const timelineMonitorActive = normalizeTimelineMonitorActive(
    project.timelineMonitorActive,
  );
  const selectedAssetId =
    selectedTimelineClipId || timelineMonitorActive
      ? null
      : normalizeSelectedAssetId(project.selectedAssetId, creationIds);
  const selectedClipId = timelineMonitorActive ? null : selectedTimelineClipId;
  const folderIds = normalizeFolderIds(project.folderIds);
  const boundFolderId = normalizeBoundFolderId(project.boundFolderId, folderIds);
  return {
    ...project,
    schemaVersion: 2,
    documentRevision:
      normalizeOptionalId(project.documentRevision) ??
      `legacy:${project.id}:${project.updatedAt}`,
    lifecycle:
      project.lifecycle === "provisioning" ||
      project.lifecycle === "repair-needed" ||
      project.lifecycle === "ready" ||
      project.lifecycle === "legacy"
        ? project.lifecycle
        : undefined,
    folderSetupIssue:
      project.folderSetupIssue === "blocked" ? "blocked" : null,
    creationIds,
    folderIds,
    boundFolderId,
    stillWorkstreams,
    aspectRatio,
    looks: normalizeProjectLooks(project.looks),
    timeline,
    selectedTimelineClipId: selectedClipId,
    selectedAssetId,
    // Keep raw JSON; editor helpers validate shape on use.
    pendingStagedDraft: selectedClipId
      ? null
      : (project.pendingStagedDraft ?? null),
    timelineZoom: normalizeTimelineZoom(project.timelineZoom),
    timelineMonitorActive,
    timelinePlayheadSec: normalizeTimelinePlayheadSec(project.timelinePlayheadSec),
    imagesGroupId: normalizeOptionalId(project.imagesGroupId),
    videosGroupId: normalizeOptionalId(project.videosGroupId),
    labStillPrompt: normalizeOptionalPrompt(project.labStillPrompt),
    labAnimatePrompt: normalizeOptionalPrompt(project.labAnimatePrompt),
    mainAudioCreationId: normalizeOptionalId(project.mainAudioCreationId),
    lyricAlignment: normalizeLyricAlignment(project.lyricAlignment),
    storyboardProposal: normalizeStoryboardProposal(project.storyboardProposal),
    labStoryboardDirection: normalizeOptionalPrompt(project.labStoryboardDirection),
  };
}

function normalizeOptionalId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Preserve a non-empty legacy binding as reconciliation evidence. */
function normalizeBoundFolderId(
  value: unknown,
  _folderIds: readonly string[],
): string | null {
  void _folderIds;
  return normalizeOptionalId(value);
}

function normalizeAlignedLyricLine(value: unknown): AlignedLyricLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.line !== "string" || !row.line.trim()) return null;
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  const inaudible =
    row.inaudible === true || isInaudibleLyricText(row.line.trim());
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
    return null;
  }
  if (!inaudible && endSec <= startSec) return null;
  const confidence = Number(row.confidence);
  return {
    line: row.line.trim(),
    startSec,
    endSec: inaudible ? startSec : endSec,
    inaudible: inaudible || undefined,
    confidence: inaudible
      ? undefined
      : Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
        ? confidence
        : undefined,
  };
}

function normalizeTranscriptSegment(
  value: unknown,
): LyricTranscript["segments"][number] | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.text !== "string" || !row.text.trim()) return null;
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }
  return { text: row.text.trim(), startSec, endSec };
}

function normalizeTranscriptWord(
  value: unknown,
): NonNullable<LyricTranscript["words"]>[number] | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const word =
    typeof row.word === "string"
      ? row.word.trim()
      : typeof row.text === "string"
        ? row.text.trim()
        : "";
  const startSec = Number(row.startSec ?? row.start);
  const endSec = Number(row.endSec ?? row.end);
  if (!word || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }
  return { word, startSec, endSec };
}

export function normalizeLyricTranscript(value: unknown): LyricTranscript | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const engine =
    row.engine === "openai" || row.engine === "local" ? row.engine : null;
  if (!engine) return null;
  if (typeof row.transcribedAt !== "string" || !row.transcribedAt.trim()) return null;
  if (typeof row.vocalsPath !== "string" || !row.vocalsPath.trim()) return null;
  if (typeof row.fullText !== "string") return null;
  if (!Array.isArray(row.segments)) return null;
  const segments = row.segments
    .map(normalizeTranscriptSegment)
    .filter((s): s is LyricTranscript["segments"][number] => s !== null);
  if (segments.length === 0) return null;
  const words = Array.isArray(row.words)
    ? row.words
        .map(normalizeTranscriptWord)
        .filter((w): w is NonNullable<LyricTranscript["words"]>[number] => w !== null)
    : [];
  const language =
    typeof row.language === "string" && row.language.trim()
      ? row.language.trim()
      : undefined;
  const vocalBlocks = Array.isArray(row.vocalBlocks)
    ? row.vocalBlocks
        .map((block) => {
          if (!block || typeof block !== "object") return null;
          const b = block as Record<string, unknown>;
          const startSec = Number(b.startSec);
          const endSec = Number(b.endSec);
          if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
          if (endSec <= startSec) return null;
          return { startSec, endSec };
        })
        .filter((b): b is { startSec: number; endSec: number } => b !== null)
    : undefined;
  return {
    engine,
    transcribedAt: row.transcribedAt.trim(),
    vocalsPath: row.vocalsPath.trim(),
    fullText: row.fullText,
    language,
    segments,
    words: words.length > 0 ? words : undefined,
    vocalBlocks: vocalBlocks?.length ? vocalBlocks : undefined,
  };
}

function needsLegacyLyricReconcile(lines: readonly AlignedLyricLine[]): boolean {
  return lines.some(
    (line) =>
      isInaudibleLyricText(line.line) &&
      line.inaudible !== true &&
      line.endSec > line.startSec + 0.001,
  );
}

function lyricLinesEqual(
  a: readonly AlignedLyricLine[],
  b: readonly AlignedLyricLine[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((line, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      line.line === other.line &&
      line.startSec === other.startSec &&
      line.endSec === other.endSec &&
      line.inaudible === other.inaudible
    );
  });
}

export function normalizeLyricAlignment(value: unknown): LyricAlignment | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sourceAudioCreationId = normalizeOptionalId(row.sourceAudioCreationId);
  if (!sourceAudioCreationId) return null;
  if (typeof row.lyricsText !== "string") return null;
  if (typeof row.alignedAt !== "string" || !row.alignedAt.trim()) return null;
  const transcribeEngine =
    row.transcribeEngine === "openai" || row.transcribeEngine === "local"
      ? row.transcribeEngine
      : null;
  if (!transcribeEngine) return null;
  if (!Array.isArray(row.lines)) return null;
  const lines = row.lines
    .map(normalizeAlignedLyricLine)
    .filter((line): line is AlignedLyricLine => line !== null);
  const durationSec = Math.max(0, ...lines.map((line) => line.endSec), 0);
  let finalLines = enforceNonOverlappingAlignedLines(lines, durationSec);
  if (needsLegacyLyricReconcile(finalLines)) {
    finalLines = reconcileAlignedLinesFromScript(row.lyricsText, finalLines);
  }
  const transcript =
    row.transcript === undefined || row.transcript === null
      ? null
      : normalizeLyricTranscript(row.transcript);
  return {
    sourceAudioCreationId,
    lyricsText: row.lyricsText,
    alignedAt: row.alignedAt.trim(),
    transcribeEngine,
    lines: finalLines,
    transcript,
  };
}

function normalizeOptionalPrompt(value: unknown): string | null {
  // Preserve empty string so Lab prompt textareas can be cleared without
  // snapping back to the shared default mid-edit. Null means "never set".
  if (typeof value !== "string") return null;
  return value;
}

export function saveStoredProjects(projects: StoredProject[]): void {
    // Never clobber a non-empty store with an empty write — usually means a
    // failed load / HMR race, not an intentional delete-all.
    if (projects.length === 0) {
      const existing = localStorage.getItem(PROJECTS_STORAGE_KEY);
      if (existing && existing !== "[]") {
        console.error(
          "[saveStoredProjects] Refusing to overwrite non-empty projects with []",
        );
        return;
      }
    }
  localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
}

export function nextProjectDocumentRevision(): string {
  const id = newId();
  return `doc:${new Date().toISOString()}:${id}`;
}

export function createStoredProject(
  title: string,
  creationIds: string[] = [],
  aspectRatio: ProjectAspectRatio = DEFAULT_PROJECT_ASPECT_RATIO,
): StoredProject {
  const trimmed = normalizeProjectTitle(title);
  const uniqueIds = [...new Set(creationIds)];
  return {
    schemaVersion: 2,
    id: newId(),
    title: trimmed,
    creationIds: uniqueIds,
    folderIds: [],
    boundFolderId: null,
    stillWorkstreams: [],
    aspectRatio: isProjectAspectRatio(aspectRatio)
      ? aspectRatio
      : DEFAULT_PROJECT_ASPECT_RATIO,
    looks: {},
    timeline: [],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    pendingStagedDraft: null,
    timelineZoom: DEFAULT_TIMELINE_ZOOM,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
    imagesGroupId: null,
    videosGroupId: null,
    labStillPrompt: null,
    labAnimatePrompt: null,
    mainAudioCreationId: null,
    lyricAlignment: null,
    storyboardProposal: null,
    labStoryboardDirection: null,
    updatedAt: new Date().toISOString(),
    documentRevision: nextProjectDocumentRevision(),
    lifecycle: "provisioning",
  };
}

/**
 * Pre–project-folder documents (no lifecycle) or intentionally unbound opens.
 * New projects always start as `provisioning` and cannot become this without
 * an explicit user choice on a true legacy document.
 */
export function isTrulyLegacyProject(
  project: Pick<StoredProject, "lifecycle">,
): boolean {
  return project.lifecycle == null || project.lifecycle === "legacy";
}

/** Sticky opt-out: open with flat `creationIds`, no folder reconcile/create. */
export function isIntentionalLegacyOpen(
  project: Pick<StoredProject, "lifecycle">,
): boolean {
  return project.lifecycle === "legacy";
}

export function markStoredProjectLegacyOpen(
  project: StoredProject,
): StoredProject {
  if (project.lifecycle === "legacy" && project.folderSetupIssue == null) {
    return project;
  }
  return {
    ...project,
    lifecycle: "legacy",
    folderSetupIssue: null,
    updatedAt: new Date().toISOString(),
  };
}

export function replaceStoredProjectAssets(
  project: StoredProject,
  creationIds: readonly string[],
): StoredProject {
  const nextIds = [...new Set(creationIds.map((id) => id.trim()).filter(Boolean))];
  if (
    nextIds.length === project.creationIds.length &&
    nextIds.every((id, index) => id === project.creationIds[index])
  ) {
    return project;
  }
  return {
    ...project,
    creationIds: nextIds,
    selectedAssetId: normalizeSelectedAssetId(project.selectedAssetId, nextIds),
    updatedAt: new Date().toISOString(),
  };
}

export function mergeCreationIds(
  project: StoredProject,
  creationIds: string[],
): StoredProject {
  const next = new Set(project.creationIds);
  for (const id of creationIds) next.add(id);
  return {
    ...project,
    creationIds: [...next],
    updatedAt: new Date().toISOString(),
  };
}

export function removeCreationIds(
  project: StoredProject,
  creationIds: string[],
): StoredProject {
  if (creationIds.length === 0) return project;
  const remove = new Set(
    creationIds.map((id) => String(id).trim()).filter(Boolean),
  );
  if (remove.size === 0) return project;

  const nextIds = project.creationIds.filter((id) => !remove.has(id));
  const prevTimeline = normalizeStoredTimeline(project.timeline);
  const nextTimeline = prevTimeline.filter((clip) => {
    if (clip.assetId && remove.has(clip.assetId)) return false;
    const slideIds = clip.slideshow?.imageAssetIds;
    if (slideIds?.some((id) => remove.has(id))) return false;
    if (clip.slideshow?.audioAssetId && remove.has(clip.slideshow.audioAssetId)) {
      return false;
    }
    return true;
  });
  const nextMainAudio =
    project.mainAudioCreationId && remove.has(project.mainAudioCreationId)
      ? null
      : project.mainAudioCreationId;
  const nextLyricAlignment =
    project.lyricAlignment &&
    remove.has(project.lyricAlignment.sourceAudioCreationId)
      ? null
      : normalizeLyricAlignment(project.lyricAlignment);
  const nextStoryboard =
    project.storyboardProposal &&
    remove.has(project.storyboardProposal.sourceAudioCreationId)
      ? null
      : normalizeStoryboardProposal(project.storyboardProposal);

  const assetsChanged = nextIds.length !== project.creationIds.length;
  const timelineChanged = nextTimeline.length !== prevTimeline.length;
  const mainAudioChanged = nextMainAudio !== project.mainAudioCreationId;
  const lyricAlignmentChanged =
    JSON.stringify(normalizeLyricAlignment(project.lyricAlignment)) !==
    JSON.stringify(nextLyricAlignment);
  const storyboardChanged =
    JSON.stringify(normalizeStoryboardProposal(project.storyboardProposal)) !==
    JSON.stringify(nextStoryboard);
  if (
    !assetsChanged &&
    !timelineChanged &&
    !mainAudioChanged &&
    !lyricAlignmentChanged &&
    !storyboardChanged
  ) {
    return project;
  }

  const nextSelectedClip = normalizeSelectedTimelineClipId(
    project.selectedTimelineClipId,
    nextTimeline,
  );
  return {
    ...project,
    creationIds: nextIds,
    timeline: nextTimeline,
    mainAudioCreationId: nextMainAudio,
    lyricAlignment: nextLyricAlignment,
    storyboardProposal: nextStoryboard,
    selectedAssetId: normalizeSelectedAssetId(project.selectedAssetId, nextIds),
    selectedTimelineClipId: nextSelectedClip,
    updatedAt: new Date().toISOString(),
  };
}

export function upsertStoredStillWorkstream(
  project: StoredProject,
  stream: StillWorkstream,
): StoredProject {
  const normalized = normalizeStillWorkstream(stream);
  if (!normalized) return project;
  const prev = normalizeStillWorkstreams(project.stillWorkstreams);
  const idx = prev.findIndex((row) => row.id === normalized.id);
  const next =
    idx >= 0
      ? prev.map((row, i) => (i === idx ? normalized : row))
      : [...prev, normalized];
  return {
    ...project,
    stillWorkstreams: next,
    updatedAt: new Date().toISOString(),
  };
}

export function removeStoredStillWorkstream(
  project: StoredProject,
  workstreamId: string,
): StoredProject {
  const id = workstreamId.trim();
  if (!id) return project;
  const prev = normalizeStillWorkstreams(project.stillWorkstreams);
  const next = prev.filter((row) => row.id !== id);
  if (next.length === prev.length) return project;
  return {
    ...project,
    stillWorkstreams: next,
    updatedAt: new Date().toISOString(),
  };
}

export function renameStoredProject(
  project: StoredProject,
  title: string,
): StoredProject {
  const trimmed = normalizeProjectTitle(title);
  if (trimmed === project.title) return project;
  return {
    ...project,
    title: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectAspectRatio(
  project: StoredProject,
  aspectRatio: ProjectAspectRatio,
): StoredProject {
  const next = isProjectAspectRatio(aspectRatio)
    ? aspectRatio
    : DEFAULT_PROJECT_ASPECT_RATIO;
  if (next === (project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO)) {
    return project;
  }
  const timeline = normalizeStoredTimeline(project.timeline).map((clip) =>
    clip.kind === "slideshow"
      ? { ...clip, bakeKey: null, bakePath: null }
      : clip,
  );
  return {
    ...project,
    aspectRatio: next,
    timeline,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectLookEnabled(
  project: StoredProject,
  lookId: ProjectLookId,
  enabled: boolean,
): StoredProject {
  if (!isProjectLookId(lookId)) return project;
  const looks = normalizeProjectLooks(project.looks);
  const prev = looks[lookId];
  const wasEnabled = prev?.enabled === true;
  if (wasEnabled === enabled) return project;
  const nextLooks: ProjectLooks = { ...looks };
  if (!enabled) {
    if (prev?.params) {
      nextLooks[lookId] = { enabled: false, params: prev.params };
    } else {
      delete nextLooks[lookId];
    }
  } else {
    // Looks are mutually exclusive — enabling one clears the others.
    for (const id of PROJECT_LOOK_IDS) {
      if (id === lookId) continue;
      const other = nextLooks[id];
      if (!other?.enabled) continue;
      if (other.params) {
        nextLooks[id] = { enabled: false, params: other.params };
      } else {
        delete nextLooks[id];
      }
    }
    nextLooks[lookId] = prev?.params
      ? { enabled: true, params: prev.params }
      : { enabled: true };
  }
  return {
    ...project,
    looks: nextLooks,
    updatedAt: new Date().toISOString(),
  };
}

function slideshowRecipesJsonEqual(
  a: SlideshowRecipe | null | undefined,
  b: SlideshowRecipe | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // Both sides are already normalizeStoredSlideshow outputs when called from
  // setStoredProjectTimeline — compare canonical JSON.
  return JSON.stringify(a) === JSON.stringify(b);
}

export function setStoredProjectTimeline(
  project: StoredProject,
  timeline: TimelineClip[],
): StoredProject {
  const prevById = new Map(
    normalizeStoredTimeline(project.timeline).map((c) => [c.id, c]),
  );
  const nextTimeline = normalizeStoredTimeline(timeline).map((clip) => {
    if (clip.kind !== "slideshow") return clip;
    const prev = prevById.get(clip.id);
    if (!prev || prev.kind !== "slideshow") return clip;
    // Timeline placement and in/out points select from an existing bake.
    // Only edits that change the baked pixels make that source stale.
    const pixelsChanged =
      (prev.framing ?? "fit") !== (clip.framing ?? "fit") ||
      !slideshowRecipesJsonEqual(prev.slideshow, clip.slideshow);
    if (!pixelsChanged) return clip;
    // A write that attaches a *new* bakePath is the bake-completion path —
    // keep it even when the recipe also changed (e.g. Random reseed + audio
    // rebind during encode). Stripping here left the UI on "Hit Render" after
    // a successful ffmpeg bake.
    const incomingBake = clip.bakePath?.trim() || null;
    const previousBake = prev.bakePath?.trim() || null;
    if (incomingBake && incomingBake !== previousBake) {
      return clip;
    }
    return { ...clip, bakeKey: null, bakePath: null };
  });
  return {
    ...project,
    timeline: nextTimeline,
    selectedTimelineClipId: normalizeSelectedTimelineClipId(
      project.selectedTimelineClipId,
      nextTimeline,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectSelectedTimelineClipId(
  project: StoredProject,
  clipId: string | null,
): StoredProject {
  const timeline = normalizeStoredTimeline(project.timeline);
  const next = normalizeSelectedTimelineClipId(clipId, timeline);
  const nextAssetId = next ? null : normalizeSelectedAssetId(
    project.selectedAssetId,
    project.creationIds,
  );
  const nextMonitorActive = next
    ? false
    : normalizeTimelineMonitorActive(project.timelineMonitorActive);
  const nextPending = next ? null : (project.pendingStagedDraft ?? null);
  if (
    next === (project.selectedTimelineClipId ?? null) &&
    nextAssetId === (project.selectedAssetId ?? null) &&
    nextMonitorActive ===
      normalizeTimelineMonitorActive(project.timelineMonitorActive) &&
    nextPending === (project.pendingStagedDraft ?? null)
  ) {
    return project;
  }
  return {
    ...project,
    selectedTimelineClipId: next,
    selectedAssetId: nextAssetId,
    timelineMonitorActive: nextMonitorActive,
    pendingStagedDraft: nextPending,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectSelectedAssetId(
  project: StoredProject,
  assetId: string | null,
): StoredProject {
  const next = normalizeSelectedAssetId(assetId, project.creationIds);
  const nextClipId = next
    ? null
    : normalizeSelectedTimelineClipId(
        project.selectedTimelineClipId,
        normalizeStoredTimeline(project.timeline),
      );
  const nextMonitorActive = next
    ? false
    : normalizeTimelineMonitorActive(project.timelineMonitorActive);
  // Clearing asset selection drops the pending source draft; switching assets
  // keeps it until the editor decides the draft no longer matches.
  const nextPending = next ? (project.pendingStagedDraft ?? null) : null;
  if (
    next === (project.selectedAssetId ?? null) &&
    nextClipId === (project.selectedTimelineClipId ?? null) &&
    nextMonitorActive ===
      normalizeTimelineMonitorActive(project.timelineMonitorActive) &&
    nextPending === (project.pendingStagedDraft ?? null)
  ) {
    return project;
  }
  return {
    ...project,
    selectedAssetId: next,
    selectedTimelineClipId: nextClipId,
    timelineMonitorActive: nextMonitorActive,
    pendingStagedDraft: nextPending,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectPendingStagedDraft(
  project: StoredProject,
  draft: unknown | null,
): StoredProject {
  const next = draft ?? null;
  if (next === (project.pendingStagedDraft ?? null)) return project;
  // Avoid writing when a timeline clip owns the selection.
  if (project.selectedTimelineClipId) {
    if ((project.pendingStagedDraft ?? null) === null) return project;
    return {
      ...project,
      pendingStagedDraft: null,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...project,
    pendingStagedDraft: next,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectTimelineZoom(
  project: StoredProject,
  zoom: number,
): StoredProject {
  const next = normalizeTimelineZoom(zoom);
  if (next === normalizeTimelineZoom(project.timelineZoom)) return project;
  return {
    ...project,
    timelineZoom: next,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectTimelineMonitorActive(
  project: StoredProject,
  active: boolean,
): StoredProject {
  const next = normalizeTimelineMonitorActive(active);
  if (next === normalizeTimelineMonitorActive(project.timelineMonitorActive)) {
    return project;
  }
  return {
    ...project,
    timelineMonitorActive: next,
    // Timeline owns the monitor — clear clip / asset selection.
    selectedTimelineClipId: next ? null : project.selectedTimelineClipId ?? null,
    selectedAssetId: next ? null : project.selectedAssetId ?? null,
    pendingStagedDraft: next ? null : project.pendingStagedDraft ?? null,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectTimelinePlayheadSec(
  project: StoredProject,
  sec: number,
): StoredProject {
  const next = normalizeTimelinePlayheadSec(sec);
  if (next === normalizeTimelinePlayheadSec(project.timelinePlayheadSec)) {
    return project;
  }
  return {
    ...project,
    timelinePlayheadSec: next,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectGroupIds(
  project: StoredProject,
  ids: { imagesGroupId?: string | null; videosGroupId?: string | null },
): StoredProject {
  const imagesGroupId =
    ids.imagesGroupId !== undefined
      ? normalizeOptionalId(ids.imagesGroupId)
      : normalizeOptionalId(project.imagesGroupId);
  const videosGroupId =
    ids.videosGroupId !== undefined
      ? normalizeOptionalId(ids.videosGroupId)
      : normalizeOptionalId(project.videosGroupId);
  if (
    imagesGroupId === normalizeOptionalId(project.imagesGroupId) &&
    videosGroupId === normalizeOptionalId(project.videosGroupId)
  ) {
    return project;
  }
  return {
    ...project,
    imagesGroupId,
    videosGroupId,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectLabPrompts(
  project: StoredProject,
  prompts: {
    labStillPrompt?: string | null;
    labAnimatePrompt?: string | null;
  },
): StoredProject {
  const labStillPrompt =
    prompts.labStillPrompt !== undefined
      ? normalizeOptionalPrompt(prompts.labStillPrompt)
      : normalizeOptionalPrompt(project.labStillPrompt);
  const labAnimatePrompt =
    prompts.labAnimatePrompt !== undefined
      ? normalizeOptionalPrompt(prompts.labAnimatePrompt)
      : normalizeOptionalPrompt(project.labAnimatePrompt);
  if (
    labStillPrompt === normalizeOptionalPrompt(project.labStillPrompt) &&
    labAnimatePrompt === normalizeOptionalPrompt(project.labAnimatePrompt)
  ) {
    return project;
  }
  return {
    ...project,
    labStillPrompt,
    labAnimatePrompt,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectMainAudioCreationId(
  project: StoredProject,
  creationId: string | null,
): StoredProject {
  const next = normalizeOptionalId(creationId);
  if (next === normalizeOptionalId(project.mainAudioCreationId)) return project;
  const lyricAlignment =
    project.lyricAlignment &&
    project.lyricAlignment.sourceAudioCreationId !== next
      ? null
      : normalizeLyricAlignment(project.lyricAlignment);
  const storyboardProposal =
    project.storyboardProposal &&
    project.storyboardProposal.sourceAudioCreationId !== next
      ? null
      : normalizeStoryboardProposal(project.storyboardProposal);
  return {
    ...project,
    mainAudioCreationId: next,
    lyricAlignment,
    storyboardProposal,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectLyricAlignment(
  project: StoredProject,
  alignment: LyricAlignment | null,
): StoredProject {
  if (!alignment) {
    if (!project.lyricAlignment) return project;
    return {
      ...project,
      lyricAlignment: null,
      updatedAt: new Date().toISOString(),
    };
  }
  const next = normalizeLyricAlignment(alignment);
  if (!next) return project;
  const prev = normalizeLyricAlignment(project.lyricAlignment);
  if (
    prev &&
    prev.alignedAt === next.alignedAt &&
    prev.lyricsText === next.lyricsText &&
    lyricLinesEqual(prev.lines, next.lines)
  ) {
    return project;
  }
  return {
    ...project,
    lyricAlignment: next,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectStoryboardProposal(
  project: StoredProject,
  proposal: StoryboardProposal | null,
): StoredProject {
  const next = proposal ? normalizeStoryboardProposal(proposal) : null;
  const prev = normalizeStoryboardProposal(project.storyboardProposal);
  if (JSON.stringify(prev) === JSON.stringify(next)) return project;
  return {
    ...project,
    storyboardProposal: next,
    updatedAt: new Date().toISOString(),
  };
}

/** Apply a generation-plan update against the latest stored storyboard proposal. */
export function patchStoredProjectStoryboardGenerationPlan(
  project: StoredProject,
  mutate: (
    plan: StoryboardGenerationPlan | undefined,
    proposal: StoryboardProposal,
  ) => StoryboardGenerationPlan,
): StoredProject {
  const proposal = normalizeStoryboardProposal(project.storyboardProposal);
  if (!proposal) return project;
  return setStoredProjectStoryboardProposal(project, {
    ...proposal,
    generationPlan: mutate(proposal.generationPlan, proposal),
  });
}

export function setStoredProjectLabStoryboardDirection(
  project: StoredProject,
  direction: string | null,
): StoredProject {
  const next = normalizeOptionalPrompt(direction);
  if (next === normalizeOptionalPrompt(project.labStoryboardDirection)) {
    return project;
  }
  return {
    ...project,
    labStoryboardDirection: next,
    updatedAt: new Date().toISOString(),
  };
}

/** Map a stored project into the shell UI Project shape. */
export function storedProjectToUi(project: StoredProject): Project {
  const stillWorkstreams = normalizeStillWorkstreams(project.stillWorkstreams);
  const internalIds = compositionInternalCreationIds(stillWorkstreams);
  const creationIds = project.creationIds.filter((id) => !internalIds.has(id));
  const assets: ProjectAsset[] = creationIds.map((id) => ({
    id,
    name: id,
    kind: "image",
  }));
  const timeline = normalizeStoredTimeline(project.timeline);
  const timelineMonitorActive = normalizeTimelineMonitorActive(
    project.timelineMonitorActive,
  );
  const selectedTimelineClipId = timelineMonitorActive
    ? null
    : normalizeSelectedTimelineClipId(project.selectedTimelineClipId, timeline);
  const selectedAssetId =
    selectedTimelineClipId || timelineMonitorActive
      ? null
      : normalizeSelectedAssetId(project.selectedAssetId, creationIds);
  return {
    id: project.id,
    title: project.title,
    aspectRatio: isProjectAspectRatio(project.aspectRatio)
      ? project.aspectRatio
      : DEFAULT_PROJECT_ASPECT_RATIO,
    looks: normalizeProjectLooks(project.looks),
    scenes: [
      {
        id: `${project.id}-scene-1`,
        title: "Scene 1",
        durationLabel: "—",
      },
    ],
    assets,
    folderIds: normalizeFolderIds(project.folderIds),
    boundFolderId: normalizeBoundFolderId(
      project.boundFolderId,
      normalizeFolderIds(project.folderIds),
    ),
    stillWorkstreams,
    imagesGroupId: normalizeOptionalId(project.imagesGroupId),
    videosGroupId: normalizeOptionalId(project.videosGroupId),
    labStillPrompt: normalizeOptionalPrompt(project.labStillPrompt),
    labAnimatePrompt: normalizeOptionalPrompt(project.labAnimatePrompt),
    mainAudioCreationId: normalizeOptionalId(project.mainAudioCreationId),
    lyricAlignment: normalizeLyricAlignment(project.lyricAlignment),
    storyboardProposal: normalizeStoryboardProposal(project.storyboardProposal),
    labStoryboardDirection: normalizeOptionalPrompt(project.labStoryboardDirection),
    timeline,
    selectedTimelineClipId,
    selectedAssetId,
    pendingStagedDraft: selectedTimelineClipId
      ? null
      : (project.pendingStagedDraft ?? null),
    timelineZoom: normalizeTimelineZoom(project.timelineZoom),
    timelineMonitorActive,
    timelinePlayheadSec: normalizeTimelinePlayheadSec(project.timelinePlayheadSec),
    hookSuggestions: [],
  };
}

/** Empty placeholder when no project is open. */
export function emptyUiProject(): Project {
  return {
    id: "",
    title: "",
    aspectRatio: DEFAULT_PROJECT_ASPECT_RATIO,
    looks: {},
    scenes: [],
    assets: [],
    folderIds: [],
    boundFolderId: null,
    stillWorkstreams: [],
    imagesGroupId: null,
    videosGroupId: null,
    labStillPrompt: null,
    labAnimatePrompt: null,
    mainAudioCreationId: null,
    lyricAlignment: null,
    storyboardProposal: null,
    labStoryboardDirection: null,
    timeline: [],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    pendingStagedDraft: null,
    timelineZoom: DEFAULT_TIMELINE_ZOOM,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
    hookSuggestions: [],
  };
}
