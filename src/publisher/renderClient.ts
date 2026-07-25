import { invoke } from "@tauri-apps/api/core";
import type { ProjectAspectRatio } from "../project/aspectRatios";
import {
  normalizeSlideshowMode,
  type SlideshowMode,
  type TimelineClip,
} from "../project/types";
import { downloadIds, getCreations } from "../library/catalogClient";
import { ensureAccessToken } from "../auth/session";
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
  reverse?: boolean;
  framing?: "fit" | "fill" | "stretch";
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

/**
 * Download any missing full media for a render, then verify local paths.
 * `downloadIds` blocks until the batch finishes (unlike ensureLocal enqueue).
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

  // Unpublished full media needs a live bearer before Rust downloads.
  await ensureAccessToken();
  await downloadIds(ids);

  const rows = await getCreations(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.get(id)?.localPath?.trim());
  if (missing.length === 0) {
    recordUiOpTrace({
      type: "render_media_ensure_ok",
      count: ids.length,
      ids: ids.slice(0, 8).join(","),
    });
    return;
  }

  recordUiOpTrace({
    type: "render_media_ensure_fail",
    count: missing.length,
    ids: missing.slice(0, 8).join(","),
    reason: "missing_local_path_after_download",
  });

  throw new Error(
    missing.length === 1
      ? `Could not download local media for ${missing[0]}. Sync it in Library, then try again.`
      : `Could not download local media for ${missing.length} assets (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}). Sync them in Library, then try again.`,
  );
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
  await ensureRenderMediaLocal(clips);
  recordUiOpTrace({
    type: "render_ffmpeg_start",
    count: clips.length,
    reason: `project=${projectId} aspect=${aspectRatio}`,
  });
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
