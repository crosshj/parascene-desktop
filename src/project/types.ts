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
  /** Transition at the head of this clip (program monitor / compose). */
  transitionIn?: ClipTransition | null;
  /** Transition at the tail of this clip. */
  transitionOut?: ClipTransition | null;
  /** Visual effects applied during compose (opacity, blur stub, …). */
  effects?: ClipEffect[] | null;
};

export type ClipTransitionKind = "cut" | "dissolve" | "fadeBlack";

export type ClipTransition = {
  kind: ClipTransitionKind;
  durationSec: number;
};

export type ClipEffectKind = "opacity" | "blur";

export type ClipEffect = {
  kind: ClipEffectKind;
  /** opacity 0..1; blur radius in px (stub). */
  value: number;
};

export type HookSuggestion = {
  id: string;
  text: string;
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
  /** Preferred main song creation id for Director / Lab (optional). */
  mainAudioCreationId: string | null;
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
