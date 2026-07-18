import { invoke } from "@tauri-apps/api/core";
import type { ProjectAspectRatio } from "../project/aspectRatios";
import {
  normalizeSlideshowMode,
  type SlideshowMode,
  type TimelineClip,
} from "../project/types";

export type RenderSlideshowRecipe = {
  imageAssetIds: string[];
  mode: SlideshowMode;
  random?: boolean;
  seed?: number;
  audioAssetId?: string;
  audioInSec?: number;
  audioOutSec?: number;
  audioStartSec?: number;
  audioEndSec?: number;
  sensitivity?: number;
};

export type RenderTimelineClipInput = {
  assetId?: string;
  startSec: number;
  endSec: number;
  lane?: "video" | "audio";
  kind?: "video" | "image" | "audio" | "slideshow";
  inSec?: number;
  outSec?: number;
  includeAudio?: boolean;
  reverse?: boolean;
  framing?: "fit" | "fill" | "stretch";
  slideshow?: RenderSlideshowRecipe;
  bakeKey?: string | null;
  bakePath?: string | null;
};

export type TimelineRender = {
  id: string;
  path: string;
  createdAt: string;
  durationSec: number;
  aspectRatio: string;
  clipCount: number;
  commandLine: string;
  status: "rendering" | "ready" | "failed";
  progress: RenderProgress | null;
  error: string | null;
};

export type RenderProgress = {
  projectId: string;
  renderId: string;
  phase: string;
  done: number;
  total: number;
};

export type RenderFinished = {
  projectId: string;
  ok: boolean;
  renderId: string;
  error: string | null;
};

export function timelineClipsToRenderInput(
  clips: readonly TimelineClip[],
): RenderTimelineClipInput[] {
  return clips.map((clip) => ({
    assetId: clip.assetId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    lane: clip.lane,
    kind: clip.kind,
    inSec: clip.inSec,
    outSec: clip.outSec,
    includeAudio: clip.includeAudio,
    reverse: clip.reverse,
    framing: clip.framing,
    slideshow: clip.slideshow
      ? {
          imageAssetIds: clip.slideshow.imageAssetIds,
          mode: normalizeSlideshowMode(clip.slideshow.mode),
          random: clip.slideshow.random === true,
          seed: clip.slideshow.random ? clip.slideshow.seed : undefined,
          audioAssetId: clip.slideshow.audioAssetId,
          audioInSec: clip.slideshow.audioInSec,
          audioOutSec: clip.slideshow.audioOutSec,
          audioStartSec: clip.slideshow.audioStartSec,
          audioEndSec: clip.slideshow.audioEndSec,
          sensitivity: clip.slideshow.sensitivity,
        }
      : undefined,
    bakeKey: clip.bakeKey,
    bakePath: clip.bakePath,
  }));
}

export async function listTimelineRenders(
  projectId: string,
): Promise<TimelineRender[]> {
  return invoke<TimelineRender[]>("publisher_list_renders", { projectId });
}

export async function renderTimeline(
  projectId: string,
  aspectRatio: ProjectAspectRatio,
  clips: RenderTimelineClipInput[],
): Promise<TimelineRender> {
  return invoke<TimelineRender>("publisher_render_timeline", {
    projectId,
    aspectRatio,
    clips,
  });
}

export async function deleteTimelineRender(
  projectId: string,
  renderId: string,
): Promise<void> {
  return invoke("publisher_delete_render", { projectId, renderId });
}

export type ExportRenderResult = {
  cancelled: boolean;
  path: string | null;
};

export async function exportTimelineRender(
  projectId: string,
  renderId: string,
  projectTitle: string,
): Promise<ExportRenderResult> {
  return invoke<ExportRenderResult>("publisher_export_render", {
    projectId,
    renderId,
    projectTitle,
  });
}
