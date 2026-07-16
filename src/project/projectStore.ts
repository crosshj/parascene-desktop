import type { Project, ProjectAsset, TimelineClip } from "./types";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  type ProjectAspectRatio,
} from "./aspectRatios";

export type StoredProject = {
  id: string;
  title: string;
  creationIds: string[];
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
    c.kind === "video" || c.kind === "image" || c.kind === "audio"
      ? c.kind
      : undefined;
  const lane =
    c.lane === "video" || c.lane === "audio"
      ? c.lane
      : kind === "audio"
        ? "audio"
        : "video";
  const inSec = Number(c.inSec);
  const outSec = Number(c.outSec);
  return {
    id: c.id,
    label: c.label,
    startSec,
    endSec,
    assetId: typeof c.assetId === "string" ? c.assetId : undefined,
    thumbUrl: typeof c.thumbUrl === "string" ? c.thumbUrl : null,
    lane,
    kind,
    inSec: Number.isFinite(inSec) ? inSec : undefined,
    outSec: Number.isFinite(outSec) ? outSec : undefined,
    includeAudio:
      typeof c.includeAudio === "boolean" ? c.includeAudio : undefined,
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
  };
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
    timeline: [],
    selectedTimelineClipId: null,
    selectedAssetId: null,
    timelineZoom: DEFAULT_TIMELINE_ZOOM,
    timelineMonitorActive: false,
    timelinePlayheadSec: 0,
    hookSuggestions: [],
  };
}
