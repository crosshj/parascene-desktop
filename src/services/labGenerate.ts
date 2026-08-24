/**
 * Lab generate via service_invoke (Blue / Replicate).
 * UI watches the handle; provider progress events remain optional chrome.
 */
import type { ReplicateRunResult } from "../replicate/replicateClient";
import {
  serviceCancel,
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import {
  parseJsonBlob,
  type ServiceHandle,
  type ServiceRun,
} from "./types";

export type LabGenerateRunResult = ReplicateRunResult;

function runResultFromJob(run: ServiceRun): LabGenerateRunResult {
  const parsed = parseJsonBlob<LabGenerateRunResult>(run.resultJson);
  if (!parsed?.predictionId) {
    throw new Error(run.error?.trim() || "Generate finished without a result");
  }
  return parsed;
}

export async function invokeBlueGenerate(opts: {
  method: string;
  args: Record<string, unknown>;
  localFiles?: Record<string, string | string[]>;
  label?: string;
  projectId?: string;
  target?: "assets" | "timeline";
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "blue",
    operation: "generate",
    projectId: opts.projectId,
    target: opts.target,
    clientRequestId: opts.clientRequestId,
    label: opts.label ?? opts.method,
    payload: {
      method: opts.method,
      args: opts.args,
      ...(opts.localFiles && Object.keys(opts.localFiles).length
        ? { localFiles: opts.localFiles }
        : {}),
    },
  });
}

export async function invokeReplicateGenerate(opts: {
  owner: string;
  name: string;
  input: Record<string, unknown>;
  localFiles?: Record<string, string | string[]>;
  requiredFileFields?: string[];
  label?: string;
  projectId?: string;
  target?: "assets" | "timeline";
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "replicate",
    operation: "generate",
    projectId: opts.projectId,
    target: opts.target,
    clientRequestId: opts.clientRequestId,
    label: opts.label ?? `${opts.owner}/${opts.name}`,
    payload: {
      owner: opts.owner,
      name: opts.name,
      input: opts.input,
      ...(opts.localFiles && Object.keys(opts.localFiles).length
        ? { localFiles: opts.localFiles }
        : {}),
      ...(opts.requiredFileFields?.length
        ? { requiredFileFields: opts.requiredFileFields }
        : {}),
    },
  });
}

export async function watchLabGenerate(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<LabGenerateRunResult> {
  const run = await watchService(handle, opts);
  if (String(run.status) === "cancelled") {
    throw new Error("Cancelled");
  }
  if (String(run.status) === "failed") {
    throw new Error(run.error?.trim() || "Generate failed");
  }
  return runResultFromJob(run);
}

/** Invoke + watch until terminal. */
export async function runBlueGenerate(opts: {
  method: string;
  args: Record<string, unknown>;
  localFiles?: Record<string, string | string[]>;
  label?: string;
  signal?: AbortSignal;
  onJob?: (jobId: string) => void;
}): Promise<LabGenerateRunResult> {
  const handle = await invokeBlueGenerate(opts);
  if (handle.mode === "job") opts.onJob?.(handle.id);
  return watchLabGenerate(handle, {
    signal: opts.signal,
    cancelOnAbort: true,
  });
}

export async function runReplicateGenerate(opts: {
  owner: string;
  name: string;
  input: Record<string, unknown>;
  localFiles?: Record<string, string | string[]>;
  requiredFileFields?: string[];
  label?: string;
  signal?: AbortSignal;
  onJob?: (jobId: string) => void;
}): Promise<LabGenerateRunResult> {
  const handle = await invokeReplicateGenerate(opts);
  if (handle.mode === "job") opts.onJob?.(handle.id);
  return watchLabGenerate(handle, {
    signal: opts.signal,
    cancelOnAbort: true,
  });
}

export async function cancelLabGenerateJob(jobId: string): Promise<void> {
  await serviceCancel(jobId);
}
