/**
 * Publisher timeline render via service_invoke (Rust owns encode from local files).
 */
import type { ProjectAspectRatio } from "../project/aspectRatios";
import type { ProjectLooks } from "../project/looks";
import { normalizeProjectLooks } from "../project/looks";
import type { TimelineRender, RenderTimelineClipInput } from "../publisher/renderClient";
import {
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import { parseJsonBlob, type ServiceHandle, type ServiceRun } from "./types";

export function parsePublisherRenderResult(run: ServiceRun): TimelineRender {
  const data = parseJsonBlob(run.resultJson);
  if (!data || typeof data !== "object") {
    throw new Error(run.error?.trim() || "Render finished without a result");
  }
  const render = (data as { render?: TimelineRender }).render;
  if (!render?.id) {
    throw new Error("Render result missing timeline render");
  }
  return render;
}

export async function invokePublisherRender(opts: {
  projectId: string;
  aspectRatio: ProjectAspectRatio | string;
  clips: RenderTimelineClipInput[];
  looks?: ProjectLooks;
  label?: string;
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "publisher",
    operation: "render",
    projectId: opts.projectId,
    label: opts.label ?? "Render timeline",
    clientRequestId: opts.clientRequestId,
    payload: {
      aspectRatio: opts.aspectRatio,
      clips: opts.clips,
      looks: normalizeProjectLooks(opts.looks),
    },
  });
}

export async function watchPublisherRender(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<TimelineRender> {
  const run = await watchService(handle, opts);
  if (run.status === "cancelled") {
    throw new Error("Cancelled");
  }
  if (run.status === "failed") {
    throw new Error(run.error?.trim() || "Render failed");
  }
  return parsePublisherRenderResult(run);
}

export async function runPublisherRender(opts: {
  projectId: string;
  aspectRatio: ProjectAspectRatio | string;
  clips: RenderTimelineClipInput[];
  looks?: ProjectLooks;
} & WatchServiceOptions): Promise<TimelineRender> {
  const { projectId, aspectRatio, clips, looks, ...watch } = opts;
  const handle = await invokePublisherRender({
    projectId,
    aspectRatio,
    clips,
    looks,
  });
  return watchPublisherRender(handle, watch);
}
