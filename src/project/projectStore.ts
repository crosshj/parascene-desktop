import type {
  Project,
  ProjectAsset,
  SlideshowRecipe,
  TimelineClip,
} from "./types";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  type ProjectAspectRatio,
} from "./aspectRatios";

export type StoredProject = {
  id: string;
  title: string;
  creationIds: string[];
  /** Local Library folder ids attached to this project; omitted on older projects → []. */
  folderIds?: string[];
  /** Creative output frame; omitted on older stored projects → default. */
  aspectRatio?: ProjectAspectRatio;
  /** Editor timeline clips; omitted on older stored projects → []. */
  timeline?: TimelineClip[];
  /** Selected timeline clip in the editor; omitted → null. */
  selectedTimelineClipId?: string | null;
  /** Selected asset in the editor assets pane; omitted → null. */
  selectedAssetId?: string | null;
  /** Timeline zoom (0.5–3); omitted → 1. */
  timelineZoom?: number;
  /** Preview follows timeline; omitted → false. */
  timelineMonitorActive?: boolean;
  /** Timeline playhead seconds; omitted → 0. */
  timelinePlayheadSec?: number;
  updatedAt: string;
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
    return parsed.filter(isStoredProject).map(normalizeStoredProject);
  } catch {
    return [];
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
    slideshow,
    bakeKey,
    bakePath,
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
  if (imageAssetIds.length < 2) return undefined;
  // Legacy projects stored mode:"random" (even timing + shuffle).
  const legacyRandom = s.mode === "random";
  const mode = s.mode === "beat" ? ("beat" as const) : ("even" as const);
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
  return recipe;
}

function normalizeStoredTimeline(value: unknown): TimelineClip[] {
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

function normalizeFolderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
}

function normalizeStoredProject(project: StoredProject): StoredProject {
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
      : normalizeSelectedAssetId(project.selectedAssetId, project.creationIds);
  const selectedClipId = timelineMonitorActive ? null : selectedTimelineClipId;
  return {
    ...project,
    folderIds: normalizeFolderIds(project.folderIds),
    aspectRatio,
    timeline,
    selectedTimelineClipId: selectedClipId,
    selectedAssetId,
    timelineZoom: normalizeTimelineZoom(project.timelineZoom),
    timelineMonitorActive,
    timelinePlayheadSec: normalizeTimelinePlayheadSec(project.timelinePlayheadSec),
  };
}

export function saveStoredProjects(projects: StoredProject[]): void {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignore quota / private mode
  }
}

export function createStoredProject(
  title: string,
  creationIds: string[] = [],
  aspectRatio: ProjectAspectRatio = DEFAULT_PROJECT_ASPECT_RATIO,
): StoredProject {
  const trimmed = title.trim() || "Untitled project";
  const uniqueIds = [...new Set(creationIds)];
  return {
    id: newId(),
    title: trimmed,
    creationIds: uniqueIds,
    folderIds: [],
    aspectRatio: isProjectAspectRatio(aspectRatio)
      ? aspectRatio
      : DEFAULT_PROJECT_ASPECT_RATIO,
    timeline: [],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    timelineZoom: DEFAULT_TIMELINE_ZOOM,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
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
  const remove = new Set(creationIds);
  const nextIds = project.creationIds.filter((id) => !remove.has(id));
  if (nextIds.length === project.creationIds.length) return project;
  return {
    ...project,
    creationIds: nextIds,
    selectedAssetId: normalizeSelectedAssetId(project.selectedAssetId, nextIds),
    updatedAt: new Date().toISOString(),
  };
}

export function mergeFolderIds(
  project: StoredProject,
  folderIds: string[],
  memberCreationIds: string[] = [],
): StoredProject {
  if (folderIds.length === 0 && memberCreationIds.length === 0) return project;
  const nextFolders = new Set(normalizeFolderIds(project.folderIds));
  for (const id of folderIds) nextFolders.add(id);
  const nextCreations = new Set(project.creationIds);
  for (const id of memberCreationIds) nextCreations.add(id);
  return {
    ...project,
    folderIds: [...nextFolders],
    creationIds: [...nextCreations],
    updatedAt: new Date().toISOString(),
  };
}

export function removeFolderIds(
  project: StoredProject,
  folderIds: string[],
  memberCreationIds: string[] = [],
): StoredProject {
  if (folderIds.length === 0 && memberCreationIds.length === 0) return project;
  const removeFolders = new Set(folderIds);
  const currentFolders = normalizeFolderIds(project.folderIds);
  const nextFolders = currentFolders.filter((id) => !removeFolders.has(id));
  const removeMembers = new Set(memberCreationIds);
  const nextCreations =
    removeMembers.size === 0
      ? project.creationIds
      : project.creationIds.filter((id) => !removeMembers.has(id));
  if (
    nextFolders.length === currentFolders.length &&
    nextCreations.length === project.creationIds.length
  ) {
    return project;
  }
  return {
    ...project,
    folderIds: nextFolders,
    creationIds: nextCreations,
    selectedAssetId: normalizeSelectedAssetId(
      project.selectedAssetId,
      nextCreations,
    ),
    updatedAt: new Date().toISOString(),
  };
}

export function renameStoredProject(
  project: StoredProject,
  title: string,
): StoredProject {
  const trimmed = title.trim() || "Untitled project";
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
  return {
    ...project,
    aspectRatio: next,
    updatedAt: new Date().toISOString(),
  };
}

export function setStoredProjectTimeline(
  project: StoredProject,
  timeline: TimelineClip[],
): StoredProject {
  const nextTimeline = normalizeStoredTimeline(timeline);
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
  if (
    next === (project.selectedTimelineClipId ?? null) &&
    nextAssetId === (project.selectedAssetId ?? null) &&
    nextMonitorActive === normalizeTimelineMonitorActive(project.timelineMonitorActive)
  ) {
    return project;
  }
  return {
    ...project,
    selectedTimelineClipId: next,
    selectedAssetId: nextAssetId,
    timelineMonitorActive: nextMonitorActive,
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
  if (
    next === (project.selectedAssetId ?? null) &&
    nextClipId === (project.selectedTimelineClipId ?? null) &&
    nextMonitorActive === normalizeTimelineMonitorActive(project.timelineMonitorActive)
  ) {
    return project;
  }
  return {
    ...project,
    selectedAssetId: next,
    selectedTimelineClipId: nextClipId,
    timelineMonitorActive: nextMonitorActive,
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

/** Map a stored project into the shell UI Project shape. */
export function storedProjectToUi(project: StoredProject): Project {
  const assets: ProjectAsset[] = project.creationIds.map((id) => ({
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
      : normalizeSelectedAssetId(project.selectedAssetId, project.creationIds);
  return {
    id: project.id,
    title: project.title,
    aspectRatio: isProjectAspectRatio(project.aspectRatio)
      ? project.aspectRatio
      : DEFAULT_PROJECT_ASPECT_RATIO,
    scenes: [
      {
        id: `${project.id}-scene-1`,
        title: "Scene 1",
        durationLabel: "—",
      },
    ],
    assets,
    folderIds: normalizeFolderIds(project.folderIds),
    timeline,
    selectedTimelineClipId,
    selectedAssetId,
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
    scenes: [],
    assets: [],
    folderIds: [],
    timeline: [],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    timelineZoom: DEFAULT_TIMELINE_ZOOM,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
    hookSuggestions: [],
  };
}
