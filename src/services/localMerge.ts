/**
 * Local timeline merge via service_invoke (Rust owns ffmpeg + catalog insert).
 */
import type { Creation } from "../library/types";
import {
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import { parseJsonBlob, type ServiceHandle, type ServiceRun } from "./types";

export type MergeClipInput = {
  assetId: string;
  inSec?: number;
  outSec?: number;
  reverse?: boolean;
};

export type MergeResult = {
  creationId: string;
  creation: Creation;
};

export function parseMergeResult(run: ServiceRun): MergeResult {
  const data = parseJsonBlob(run.resultJson);
  if (!data || typeof data !== "object") {
    throw new Error(run.error?.trim() || "Merge finished without a result");
  }
  const row = data as Record<string, unknown>;
  const creation = row.creation as Creation | undefined;
  const creationId =
    (typeof row.creationId === "string" && row.creationId.trim()) ||
    creation?.id?.trim() ||
    "";
  if (!creationId || !creation) {
    throw new Error("Merge result missing creation");
  }
  return { creationId, creation };
}

export async function invokeLocalMerge(opts: {
  clips: MergeClipInput[];
  label?: string;
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "local",
    operation: "merge",
    label: opts.label ?? "Merge clips",
    clientRequestId: opts.clientRequestId,
    payload: { clips: opts.clips },
  });
}

export async function watchLocalMerge(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<MergeResult> {
  const run = await watchService(handle, opts);
  if (run.status === "cancelled") {
    throw new Error("Cancelled");
  }
  if (run.status === "failed") {
    throw new Error(run.error?.trim() || "Merge failed");
  }
  return parseMergeResult(run);
}

/** Invoke + watch until the merged creation is in the catalog. */
export async function runLocalMerge(
  clips: MergeClipInput[],
  opts?: WatchServiceOptions,
): Promise<Creation> {
  const handle = await invokeLocalMerge({ clips });
  const result = await watchLocalMerge(handle, opts);
  return result.creation;
}
