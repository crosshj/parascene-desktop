/**
 * Cloud library repair via service_invoke.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SyncStatus } from "../library/types";
import type { SyncItemEvent } from "../sync/syncActivity";
import {
  serviceInvoke,
  watchService,
} from "./serviceClient";
import { parseJsonBlob, type ServiceHandle, type ServiceRun } from "./types";

export type CloudRepairResult = {
  groupUpdated: number;
  fitUpdated: number;
  fitSkipped: number;
  localFilled: number;
  uploadedOnly: number;
  thumbsRedownloaded: number;
  status: SyncStatus;
};

export type CloudRepairProgress = {
  message: string;
  phase?: string;
};

function asSyncStatus(value: unknown): SyncStatus | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.total !== "number") return null;
  return value as SyncStatus;
}

export function parseCloudRepairResult(run: ServiceRun): CloudRepairResult {
  const data = parseJsonBlob(run.resultJson);
  if (!data || typeof data !== "object") {
    throw new Error(run.error?.trim() || "Cloud repair finished without a result");
  }
  const row = data as Record<string, unknown>;
  const status = asSyncStatus(row.status);
  if (!status) {
    throw new Error("Cloud repair result missing status");
  }
  return {
    groupUpdated: typeof row.groupUpdated === "number" ? row.groupUpdated : 0,
    fitUpdated: typeof row.fitUpdated === "number" ? row.fitUpdated : 0,
    fitSkipped: typeof row.fitSkipped === "number" ? row.fitSkipped : 0,
    localFilled: typeof row.localFilled === "number" ? row.localFilled : 0,
    uploadedOnly: typeof row.uploadedOnly === "number" ? row.uploadedOnly : 0,
    thumbsRedownloaded:
      typeof row.thumbsRedownloaded === "number" ? row.thumbsRedownloaded : 0,
    status,
  };
}

export async function invokeCloudRepair(opts?: {
  label?: string;
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "sync",
    operation: "cloud_repair",
    label: opts?.label ?? "Cloud repair",
    clientRequestId: opts?.clientRequestId,
    payload: {},
  });
}

export function listenCloudRepairItems(
  handler: (event: SyncItemEvent) => void,
): Promise<UnlistenFn> {
  return listen<SyncItemEvent>("library-repair-item", (event) => {
    handler(event.payload);
  });
}

export async function runCloudRepair(opts?: {
  onProgress?: (progress: CloudRepairProgress) => void;
  onItem?: (event: SyncItemEvent) => void;
  signal?: AbortSignal;
}): Promise<CloudRepairResult> {
  let offItem: UnlistenFn | undefined;
  if (opts?.onItem) {
    offItem = await listenCloudRepairItems(opts.onItem);
  }
  try {
    const handle = await invokeCloudRepair();
    const run = await watchService(handle, {
      signal: opts?.signal,
      cancelOnAbort: true,
      onUpdate: (next) => {
        const note = next.progressNote?.trim();
        if (note) {
          opts?.onProgress?.({ message: note, phase: next.status });
        }
      },
    });
    if (run.status === "cancelled") {
      throw new Error("Cancelled");
    }
    if (run.status === "failed") {
      throw new Error(run.error?.trim() || "Cloud repair failed");
    }
    return parseCloudRepairResult(run);
  } finally {
    offItem?.();
  }
}
