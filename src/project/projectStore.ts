import {
  clampSensitivity,
  normalizeSlideshowMode,
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
    isAddAssetPlaceholder:
      c.isAddAssetPlaceholder === true ? true : undefined,
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
      JSON.stringify(prev.slideshow) !== JSON.stringify(clip.slideshow);
    if (!pixelsChanged) return clip;
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
    scenes: [],
    assets: [],
    folderIds: [],
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
