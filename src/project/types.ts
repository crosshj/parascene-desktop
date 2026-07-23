import type { ProjectAspectRatio } from "./aspectRatios";

export type LayoutMode = "director" | "editor" | "hook" | "lab";

export type Scene = {
  id: string;
  title: string;
  durationLabel: string;
};

export type ProjectAsset = {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  /** Display duration for video/audio tiles (layout stub). */
  durationLabel?: string;
};

/** How a composite image slideshow assigns image spans. */
export type SlideshowMode =
  | "even"
  | "beat_classic"
  | "beat_grid"
  | "beat_drums"
  | "beat_energy";

export function isBeatSlideshowMode(mode: unknown): mode is Exclude<
  SlideshowMode,
  "even"
> {
  return (
    mode === "beat_classic" ||
    mode === "beat_grid" ||
    mode === "beat_drums" ||
    mode === "beat_energy"
  );
}

/** Normalize persisted modes; legacy `beat` means the latest full algorithm. */
export function normalizeSlideshowMode(mode: unknown): SlideshowMode {
  if (isBeatSlideshowMode(mode)) return mode;
  return mode === "beat" ? "beat_energy" : "even";
}

/** Neutral sensitivity reproducing each mode's default feel. */
export const DEFAULT_SLIDESHOW_SENSITIVITY = 0.5;

/** Clamp a persisted/user sensitivity into the valid 0..1 range. */
export function clampSensitivity(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/** Recipe for a composite image slideshow clip. */
export type SlideshowRecipe = {
  imageAssetIds: string[];
  mode: SlideshowMode;
  /** When true, images are shuffled with `seed` before even/beat timing. */
  random?: boolean;
  /** Deterministic shuffle seed used when `random` is true. */
  seed?: number;
  /** Audio asset used for beat mapping (set on drop for beat mode). */
  audioAssetId?: string;
  /** Source trim of the audio asset used for beat mapping. */
  audioInSec?: number;
  audioOutSec?: number;
  /** Timeline placement of the overlapping audio clip. */
  audioStartSec?: number;
  audioEndSec?: number;
  /** Per-mode tuning dial (0..1); undefined uses the neutral default. */
  sensitivity?: number;
};

export type TimelineClip = {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
  /** Library creation / asset id when staged from preview. */
  assetId?: string;
  thumbUrl?: string | null;
  lane?: "video" | "audio";
  /** Source media kind used when staging. */
  kind?: "video" | "image" | "audio" | "slideshow";
  /** Source in/out used to build this clip. */
  inSec?: number;
  outSec?: number;
  includeAudio?: boolean;
  /** Play a behind-the-scenes FFmpeg-reversed copy of the source asset. */
  reverse?: boolean;
  transform?: "hold" | "kenBurns";
  framing?: "fit" | "fill" | "stretch";
  /** Composite image slideshow recipe when kind is "slideshow". */
  slideshow?: SlideshowRecipe;
  /** Content-addressed key for the cached silent bake. */
  bakeKey?: string | null;
  /** Absolute path to the cached silent bake MP4 when ready. */
  bakePath?: string | null;
  /** Placeholder clip staged from the add-asset slot (no library asset yet). */
  isAddAssetPlaceholder?: boolean;
};

export type HookSuggestion = {
  id: string;
  text: string;
};

/** One lyric line with start/end on the main song timeline. */
export type AlignedLyricLine = {
  line: string;
  startSec: number;
  endSec: number;
  /** 0..1 when produced by the aligner; omitted after manual edits. */
  confidence?: number;
  /** Suno section tag ([Intro], etc.) — shown but not matched to audio. */
  inaudible?: boolean;
};

/**
 * Persisted Whisper (or local) transcription for lyric align.
 * Reused across aligns until the vocals stem or engine changes, or the user refreshes.
 */
export type LyricTranscript = {
  engine: "openai" | "local";
  transcribedAt: string;
  /** Absolute path of the vocals stem that was transcribed. */
  vocalsPath: string;
  fullText: string;
  language?: string;
  segments: Array<{
    text: string;
    startSec: number;
    endSec: number;
  }>;
  /** Per-word timings when Whisper provides them. */
  words?: Array<{
    word: string;
    startSec: number;
    endSec: number;
  }>;
  /** Silence-separated vocal regions used for block-wise transcription. */
  vocalBlocks?: Array<{
    startSec: number;
    endSec: number;
  }>;
};

/**
 * Persisted lyric alignment for Director / storyboard propose.
 * `lines` may be empty when the user has saved lyrics text but not yet aligned.
 * `transcript` caches the STT response so Align can skip repeat Whisper calls.
 */
export type LyricAlignment = {
  sourceAudioCreationId: string;
  lyricsText: string;
  alignedAt: string;
  transcribeEngine: "openai" | "local";
  lines: AlignedLyricLine[];
  transcript?: LyricTranscript | null;
};

/** How a scene's visuals are sourced in production. */
export type SceneProductionMethod =
  | "new_still"
  | "new_video"
  | "a2v_from_still"
  | "loop_clip"
  | "extend_clip"
  | "mutate_still"
  | "lyric_card"
  | "reuse_clip";

export type StoryboardShotType =
  | "lip_sync_cu"
  | "lip_sync_mcu"
  | "wide_performance"
  | "instrument_detail"
  | "metaphor_broll"
  | "location_plate"
  | "lyric_card"
  | "crowd_energy"
  | "push_in"
  | "static_hold"
  | "chorus_punch"
  | "bridge_reset"
  | "outro_hold";

export type StoryboardConceptOption = {
  id: string;
  title: string;
  logline: string;
  visualApproach: string;
  mood: string;
  feasibilityScore: number;
  feasibilityRationale: string;
  tradeoffs: string;
};

export type BrainstormTurn = {
  at: string;
  kind: "options" | "refine" | "user";
  userMessage?: string;
  options?: StoryboardConceptOption[];
  refinedOption?: StoryboardConceptOption;
  parentOptionId?: string;
};

/** Locked creative direction — input to budget + scenes. */
export type StoryboardConcept = {
  lockedAt: string;
  source: "brainstorm" | "manual";
  optionId: string;
  title: string;
  logline: string;
  visualApproach: string;
  mood: string;
  feasibilityScore: number;
  feasibilityRationale: string;
  tradeoffs: string;
  userNotes?: string;
};

export type BrainstormSession = {
  startedAt: string;
  seedPrompt?: string;
  turns: BrainstormTurn[];
  lockedConcept?: StoryboardConcept;
};

export type VisualGroup = {
  id: string;
  label: string;
  basePromptHint: string;
  productionMethod: SceneProductionMethod;
  masterSceneId?: string;
  notes?: string;
};

export type ProposedScene = {
  id: string;
  startSec: number;
  endSec: number;
  shotType: StoryboardShotType;
  visualGroupId: string;
  title?: string;
  note: string;
  promptHint: string;
  lyricLineIndices?: number[];
  productionMethod?: SceneProductionMethod;
  reuseFromSceneId?: string;
  vocalSlice?: { inSec: number; outSec: number };
  vocalSliceWarning?: string;
};

export type StoryboardBudget = {
  plannedAt: string;
  model: string;
  durationSec: number;
  maxUniqueStills: number;
  maxUniqueVideoMasters: number;
  targetSceneCount: number;
  reuseStrategy: string;
  sectionNotes?: Array<{
    tag: string;
    startSec: number;
    endSec: number;
    note: string;
  }>;
};

export type StoryboardProposal = {
  sourceAudioCreationId: string;
  durationSec: number;
  aspectRatio: ProjectAspectRatio;
  brainstorm: BrainstormSession;
  budget?: StoryboardBudget;
  proposedAt?: string;
  model?: string;
  logline?: string;
  visualGroups: VisualGroup[];
  scenes: ProposedScene[];
  notes?: string;
  uniqueStillCount?: number;
  uniqueVideoMasterCount?: number;
};

export type { ProjectAspectRatio };

export type Project = {
  id: string;
  title: string;
  /** Creative output frame — Library aspect filter presets. */
  aspectRatio: ProjectAspectRatio;
  scenes: Scene[];
  assets: ProjectAsset[];
  /** Local Library folder ids attached to this project. */
  folderIds: string[];
  /**
   * Parascene group creation ids for this project's Images / Videos buckets.
   * Null until Lab (or create flow) ensures the cloud group exists.
   */
  imagesGroupId: string | null;
  videosGroupId: string | null;
  /**
   * Lab Project-groups still prompt (image mint). Null uses the shared Lab
   * default until the user edits it in Lab.
   */
  labStillPrompt: string | null;
  /**
   * Lab Project-groups animate prompt (image→video). Null uses the shared Lab
   * default until the user edits it in Lab.
   */
  labAnimatePrompt: string | null;
  /** Preferred main song creation id for Director / Lab (optional). */
  mainAudioCreationId: string | null;
  /** Lab lyric align output — timed lines on the main song. */
  lyricAlignment: LyricAlignment | null;
  /** Lab MV storyboard pipeline output. */
  storyboardProposal: StoryboardProposal | null;
  /** Seed creative direction for MV Concept module. */
  labStoryboardDirection: string | null;
  timeline: TimelineClip[];
  /** Selected timeline clip id (editor); null when none. */
  selectedTimelineClipId: string | null;
  /** Selected library asset id in the editor; null when none. */
  selectedAssetId: string | null;
  /**
   * Source-preview staging draft (mode, sensitivity, duration, etc.) saved
   * before the clip is dropped on the timeline. Cleared when a timeline clip
   * is selected. Opaque JSON — normalized by the editor staging helpers.
   */
  pendingStagedDraft?: unknown | null;
  /** Timeline zoom multiplier (0.5–3). */
  timelineZoom: number;
  /** Preview follows the timeline (program monitor). */
  timelineMonitorActive: boolean;
  /** Timeline playhead position in seconds. */
  timelinePlayheadSec: number;
  hookSuggestions: HookSuggestion[];
};

export interface ProjectRepository {
  getProject(): Project;
}
