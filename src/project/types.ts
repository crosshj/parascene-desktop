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
  kind?: "video" | "image" | "audio";
  /** Source in/out used to build this clip. */
  inSec?: number;
  outSec?: number;
  includeAudio?: boolean;
  transform?: "hold" | "kenBurns";
  framing?: "fit" | "fill" | "stretch";
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
  timeline: TimelineClip[];
  /** Selected timeline clip id (editor); null when none. */
  selectedTimelineClipId: string | null;
  /** Selected library asset id in the editor; null when none. */
  selectedAssetId: string | null;
  /** Timeline zoom multiplier (0.5–3). */
  timelineZoom: number;
  hookSuggestions: HookSuggestion[];
};

export interface ProjectRepository {
  getProject(): Project;
}
