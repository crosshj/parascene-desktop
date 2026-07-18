import type { ProjectAspectRatio } from "./aspectRatios";

export type LayoutMode = "director" | "editor" | "hook";

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
export type SlideshowMode = "even" | "beat";

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
  timeline: TimelineClip[];
  /** Selected timeline clip id (editor); null when none. */
  selectedTimelineClipId: string | null;
  /** Selected library asset id in the editor; null when none. */
  selectedAssetId: string | null;
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
