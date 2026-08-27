import { invoke } from "@tauri-apps/api/core";
import type { ProjectAspectRatio } from "../project/aspectRatios";
import type { ProjectLooks } from "../project/looks";
import {
  normalizeSlideshowMode,
  type SlideshowMode,
  type TimelineClip,
} from "../project/types";
import { getCreations } from "../library/catalogClient";
import { syncLinkedVideoAudio } from "../layouts/editor/linkedVideoAudio";
import { recordUiOpTrace } from "../layouts/editor/uiOpTrace";

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
  /** Set on Master Audio companions linked to a video Include Audio clip. */
  linkedVideoClipId?: string;
  reverse?: boolean;
  framing?: "fit" | "fill" | "stretch";
  /** Image instance zoom (1 = none). Baked into preview/export frames. */
  zoom?: number;
  centerX?: number;
  centerY?: number;
  slideshow?: RenderSlideshowRecipe;
  bakeKey?: string | null;
  bakePath?: string | null;
  extendPingPong?: boolean;
  extendSourceSpanSec?: number;
  extendBakePath?: string | null;
  extendBakeCoverSec?: number;
  speed?: number;
};

export type TimelineRender = {
  id: string;
  path: string;
  createdAt: string;
  /** Set when the render leaves `rendering` (ready or failed). */
  finishedAt?: string | null;
  durationSec: number;
  aspectRatio: string;
  clipCount: number;
  commandLine: string;
  /** Look name baked into this render, if any (e.g. "TV"). */
  lookLabel?: string | null;
  status: "rendering" | "ready" | "failed";
  progress: RenderProgress | null;
  error: string | null;
};

export type RenderProgress = {
  projectId: string;
  renderId: string;
  /** prepare | encode_segment | concat | render (legacy) */
  phase: string;
  done: number;
  total: number;
  message?: string | null;
  segmentIndex?: number | null;
  segmentCount?: number | null;
  segmentDurationSec?: number | null;
  timelineDurationSec?: number | null;
  lookEnabled?: boolean | null;
  lookLabel?: string | null;
  currentCommand?: string | null;
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
  // Materialize Include Audio companions so render matches the editor lane.
  return syncLinkedVideoAudio(clips).map((clip) => ({
    assetId: clip.assetId,
    startSec: clip.startSec,
    endSec: clip.endSec,
    lane: clip.lane,
    kind: clip.kind,
    inSec: clip.inSec,
    outSec: clip.outSec,
    includeAudio: clip.includeAudio,
    linkedVideoClipId: clip.linkedVideoClipId,
    reverse: clip.reverse,
    framing: clip.framing,
    zoom: clip.zoom,
    centerX: clip.centerX,
    centerY: clip.centerY,
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
    extendPingPong: clip.extendPingPong,
    extendSourceSpanSec: clip.extendSourceSpanSec,
    extendBakePath: clip.extendBakePath,
    extendBakeCoverSec: clip.extendBakeCoverSec,
    speed: clip.speed,
  }));
}

/** Unique catalog ids a timeline render needs on disk (full media). */
export function collectRenderAssetIds(
  clips: readonly RenderTimelineClipInput[],
): string[] {
  const ids = new Set<string>();
  const add = (value: string | null | undefined) => {
    const id = typeof value === "string" ? value.trim() : "";
    if (id) ids.add(id);
  };
  for (const clip of clips) {
    add(clip.assetId);
    const slideshow = clip.slideshow;
    if (!slideshow) continue;
    for (const imageId of slideshow.imageAssetIds) add(imageId);
    add(slideshow.audioAssetId);
  }
  return Array.from(ids);
}

export type RenderMediaLocality = {
  /** Asset ids that have a localPath on disk. */
  readyIds: string[];
  /** Asset ids that are catalogued but not yet on disk. */
  missingIds: string[];
};

/**
 * Probe which render assets already have local files. Does not download.
 */
export async function probeRenderMediaLocal(
  clips: readonly RenderTimelineClipInput[],
): Promise<RenderMediaLocality> {
  const ids = collectRenderAssetIds(clips);
  if (ids.length === 0) {
    return { readyIds: [], missingIds: [] };
  }
  const rows = await getCreations(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const readyIds: string[] = [];
  const missingIds: string[] = [];
  for (const id of ids) {
    if (byId.get(id)?.localPath?.trim()) readyIds.push(id);
    else missingIds.push(id);
  }
  return { readyIds, missingIds };
}

/**
 * Drop clips whose assets are not yet on disk. Placeholders / missing media
 * become black gaps in the bake instead of failing the whole fragment.
 */
export async function filterRenderMediaLocal(
  clips: readonly RenderTimelineClipInput[],
): Promise<{
  clips: RenderTimelineClipInput[];
  readyIds: string[];
  missingIds: string[];
}> {
  const { readyIds, missingIds } = await probeRenderMediaLocal(clips);
  const ready = new Set(readyIds);
  const filtered = clips.filter((clip) => {
    const assetId = clip.assetId?.trim();
    if (!assetId) {
      // Slideshow / bake-path-only clips keep going; FFmpeg uses bakePath.
      return Boolean(clip.bakePath?.trim() || clip.extendBakePath?.trim());
    }
    if (ready.has(assetId)) return true;
    const slideshow = clip.slideshow;
    if (!slideshow) return false;
    // Keep slideshow if every image is local (audio optional for silent bake).
    return slideshow.imageAssetIds.every((id) => ready.has(id.trim()));
  });
  return { clips: filtered, readyIds, missingIds };
}

/**
 * Confirm render assets already have local files. Does not download.
 * Generation and Sync own network; Publisher encode uses disk only.
 */
export async function ensureRenderMediaLocal(
  clips: readonly RenderTimelineClipInput[],
): Promise<void> {
  const ids = collectRenderAssetIds(clips);
  if (ids.length === 0) {
    recordUiOpTrace({
      type: "render_media_ensure_skip",
      reason: "no_asset_ids",
    });
    return;
  }

  recordUiOpTrace({
    type: "render_media_ensure_start",
    count: ids.length,
    ids: ids.slice(0, 8).join(","),
  });

  const { missingIds } = await probeRenderMediaLocal(clips);
  if (missingIds.length === 0) {
    recordUiOpTrace({
      type: "render_media_ensure_ok",
      count: ids.length,
      ids: ids.slice(0, 8).join(","),
    });
    return;
  }

  recordUiOpTrace({
    type: "render_media_ensure_fail",
    count: missingIds.length,
    ids: missingIds.slice(0, 8).join(","),
    reason: "missing_local_path",
  });

  throw new Error(
    missingIds.length === 1
      ? `No local file on disk for ${missingIds[0]}. Sync the library, then try again.`
      : `No local files on disk for ${missingIds.length} assets (${missingIds.slice(0, 5).join(", ")}${missingIds.length > 5 ? "…" : ""}). Sync the library, then try again.`,
  );
}

export async function listTimelineRenders(
  projectId: string,
): Promise<TimelineRender[]> {
  return invoke<TimelineRender[]>("publisher_list_renders", { projectId });
}

export async function getTimelineRender(
  projectId: string,
  renderId: string,
): Promise<TimelineRender> {
  return invoke<TimelineRender>("publisher_get_render", { projectId, renderId });
}

export async function startTimelineRender(
  projectId: string,
  aspectRatio: ProjectAspectRatio,
  clips: RenderTimelineClipInput[],
  looks?: ProjectLooks,
) {
  const { invokePublisherRender } = await import("../services/publisherRender");
  recordUiOpTrace({
    type: "render_ffmpeg_start",
    count: clips.length,
    reason: `project=${projectId} aspect=${aspectRatio}`,
  });
  return invokePublisherRender({
    projectId,
    aspectRatio,
    clips,
    looks,
  });
}

export async function renderTimeline(
  projectId: string,
  aspectRatio: ProjectAspectRatio,
  clips: RenderTimelineClipInput[],
  looks?: ProjectLooks,
): Promise<TimelineRender> {
  const { runPublisherRender } = await import("../services/publisherRender");
  recordUiOpTrace({
    type: "render_ffmpeg_start",
    count: clips.length,
    reason: `project=${projectId} aspect=${aspectRatio}`,
  });
  return runPublisherRender({
    projectId,
    aspectRatio,
    clips,
    looks,
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

export async function exportTimelineRenderAudio(
  projectId: string,
  renderId: string,
  projectTitle: string,
): Promise<ExportRenderResult> {
  return invoke<ExportRenderResult>("publisher_export_render_audio", {
    projectId,
    renderId,
    projectTitle,
  });
}
