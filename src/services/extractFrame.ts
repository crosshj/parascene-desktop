/**
 * Local extract_frame via service_invoke (sync Result handle).
 */
import { serviceInvoke } from "./serviceClient";

export type ExtractFrameOpts = {
  id: string;
  reverse?: boolean;
  timeSec?: number;
  framing?: "fit" | "fill" | "stretch";
  aspectRatio?: string;
  zoom?: number;
  centerX?: number;
  centerY?: number;
};

export async function extractFrame(opts: ExtractFrameOpts): Promise<string> {
  const handle = await serviceInvoke({
    service: "local",
    operation: "extract_frame",
    payload: {
      id: opts.id,
      reverse: opts.reverse ?? false,
      timeSec: opts.timeSec ?? 0,
      framing: opts.framing,
      aspectRatio: opts.aspectRatio,
      zoom: opts.zoom,
      centerX: opts.centerX,
      centerY: opts.centerY,
    },
  });
  if (handle.mode !== "result") {
    throw new Error("extract_frame expected a sync result handle");
  }
  const data = handle.data as { path?: unknown } | null;
  const path = typeof data?.path === "string" ? data.path.trim() : "";
  if (!path) {
    throw new Error("extract_frame returned no path");
  }
  return path;
}
