/**
 * Resolve r2v/v2v still slots: Assets images or I2V-style neighbor frames.
 */

import { applyImageFraming } from "../../lab/audioTools";
import {
  peekTimelineFrameSlot,
  startFrameIsReady,
  type StartFramePreview,
} from "./addAssetStartFrame";
import {
  isTimelineImageRefId,
  timelineImageRefLabel,
  timelineImageRefRole,
} from "./generateMediaRefs";
import type { TimelineClip } from "../../project/types";
import { resolveLocalMediaPath } from "./resolveLocalMedia";

export async function resolveReferenceImageStill(opts: {
  id: string;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  aspectRatio: string;
}): Promise<StartFramePreview> {
  const id = opts.id.trim();
  const role = timelineImageRefRole(id);
  if (role) {
    const preview = await peekTimelineFrameSlot({
      role,
      timeline: opts.timeline,
      placeholder: opts.placeholder,
      aspectRatio: opts.aspectRatio,
    });
    if (!startFrameIsReady(preview)) {
      const label = timelineImageRefLabel(id) ?? "Timeline still";
      throw new Error(
        `${label} is not available. Place a neighbor clip on the timeline, or pick an Assets image.`,
      );
    }
    return preview;
  }
  const sourcePath = await resolveLocalMediaPath(id, { label: "reference image" });
  const framed = await applyImageFraming({
    sourcePath,
    framing: "fit",
    aspectRatio: opts.aspectRatio,
  });
  const path = framed.path.trim();
  if (!path) {
    throw new Error("Could not prepare a still for generation.");
  }
  return {
    previewUrl: framed.mediaUrl,
    note: "",
    framePath: path,
    frameTimeSec: null,
    sourceAssetId: id,
    sourceIsImage: true,
  };
}

export async function resolveReferenceImageStillPath(opts: {
  id: string;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  aspectRatio: string;
}): Promise<string> {
  const still = await resolveReferenceImageStill(opts);
  const path = still.framePath?.trim();
  if (!path) {
    const label = isTimelineImageRefId(opts.id)
      ? timelineImageRefLabel(opts.id) ?? "Timeline still"
      : "Reference image";
    throw new Error(`${label} has no local file.`);
  }
  return path;
}

export async function resolveReferenceImageStillPaths(
  ids: readonly string[],
  opts: {
    timeline: readonly TimelineClip[];
    placeholder: TimelineClip;
    aspectRatio: string;
  },
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    out.push(
      await resolveReferenceImageStillPath({
        id: trimmed,
        timeline: opts.timeline,
        placeholder: opts.placeholder,
        aspectRatio: opts.aspectRatio,
      }),
    );
  }
  return out;
}
