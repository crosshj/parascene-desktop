/**
 * Catalog sync via service_invoke (Rust owns fetch → map → upsert → prune).
 */
import type { SyncStatus } from "../library/types";
import {
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import { parseJsonBlob, type ServiceHandle, type ServiceRun } from "./types";

export type SyncNewestResult = {
  status: SyncStatus;
  added: number;
  pruned: number;
  checked: number;
  target: number;
  message: string;
};

export type SyncNewestProgress = {
  message: string;
  checked?: number;
  target?: number;
  added?: number;
  pruned?: number;
  phase?: string;
};

function asSyncStatus(value: unknown): SyncStatus | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.total !== "number") return null;
  return value as SyncStatus;
}

export function parseSyncNewestResult(run: ServiceRun): SyncNewestResult {
  const data = parseJsonBlob(run.resultJson);
  if (!data || typeof data !== "object") {
    throw new Error(run.error?.trim() || "Sync newest finished without a result");
  }
  const row = data as Record<string, unknown>;
  const status = asSyncStatus(row.status);
  if (!status) {
    throw new Error("Sync newest result missing status");
  }
  return {
    status,
    added: typeof row.added === "number" ? row.added : 0,
    pruned: typeof row.pruned === "number" ? row.pruned : 0,
    checked: typeof row.checked === "number" ? row.checked : 0,
    target: typeof row.target === "number" ? row.target : 100,
    message:
      typeof row.message === "string" && row.message.trim()
        ? row.message.trim()
        : run.progressNote?.trim() || "Done",
  };
}

export async function invokeSyncNewest(opts?: {
  label?: string;
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "sync",
    operation: "sync_newest",
    label: opts?.label ?? "Sync newest",
    clientRequestId: opts?.clientRequestId,
    payload: {},
  });
}

export async function watchSyncNewest(
  handle: ServiceHandle,
  opts?: WatchServiceOptions & {
    onProgress?: (progress: SyncNewestProgress) => void;
  },
): Promise<SyncNewestResult> {
  const run = await watchService(handle, {
    ...opts,
    onUpdate: (next) => {
      opts?.onUpdate?.(next);
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
    throw new Error(run.error?.trim() || "Sync newest failed");
  }
  return parseSyncNewestResult(run);
}

/** Invoke + watch; paints via onProgress. */
export async function runSyncNewest(opts?: {
  onProgress?: (progress: SyncNewestProgress) => void;
  signal?: AbortSignal;
}): Promise<SyncNewestResult> {
  const handle = await invokeSyncNewest();
  return watchSyncNewest(handle, {
    onProgress: opts?.onProgress,
    signal: opts?.signal,
    cancelOnAbort: true,
  });
}

export type SyncFullResult = {
  status: SyncStatus;
  added: number;
  checked: number;
  pages: number;
  message: string;
};

export type SyncFullProgress = {
  message: string;
  checked?: number;
  pages?: number;
  added?: number;
  phase?: string;
};

export function parseSyncFullResult(run: ServiceRun): SyncFullResult {
  const data = parseJsonBlob(run.resultJson);
  if (!data || typeof data !== "object") {
    throw new Error(run.error?.trim() || "Sync full finished without a result");
  }
  const row = data as Record<string, unknown>;
  const status = asSyncStatus(row.status);
  if (!status) {
    throw new Error("Sync full result missing status");
  }
  return {
    status,
    added: typeof row.added === "number" ? row.added : 0,
    checked: typeof row.checked === "number" ? row.checked : 0,
    pages: typeof row.pages === "number" ? row.pages : 0,
    message:
      typeof row.message === "string" && row.message.trim()
        ? row.message.trim()
        : run.progressNote?.trim() || "Done",
  };
}

export async function invokeSyncFull(opts?: {
  label?: string;
  clientRequestId?: string;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "sync",
    operation: "sync_full",
    label: opts?.label ?? "Sync full catalog",
    clientRequestId: opts?.clientRequestId,
    payload: {},
  });
}

export async function watchSyncFull(
  handle: ServiceHandle,
  opts?: WatchServiceOptions & {
    onProgress?: (progress: SyncFullProgress) => void;
  },
): Promise<SyncFullResult> {
  const run = await watchService(handle, {
    ...opts,
    onUpdate: (next) => {
      opts?.onUpdate?.(next);
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
    throw new Error(run.error?.trim() || "Sync full failed");
  }
  return parseSyncFullResult(run);
}

export async function runSyncFull(opts?: {
  onProgress?: (progress: SyncFullProgress) => void;
  signal?: AbortSignal;
}): Promise<SyncFullResult> {
  const handle = await invokeSyncFull();
  return watchSyncFull(handle, {
    onProgress: opts?.onProgress,
    signal: opts?.signal,
    cancelOnAbort: true,
  });
}

export async function refreshCreationsFromListById(
  ids: readonly string[],
  opts?: { maxPages?: number; pageSize?: number },
): Promise<number> {
  const wanted = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  if (wanted.length === 0) return 0;
  const handle = await serviceInvoke({
    service: "sync",
    operation: "refresh_ids",
    payload: {
      ids: wanted,
      maxPages: opts?.maxPages,
      pageSize: opts?.pageSize,
    },
  });
  if (handle.mode !== "result") {
    throw new Error("sync.refresh_ids expected a sync result handle");
  }
  const data = handle.data as { refreshed?: unknown } | null;
  return typeof data?.refreshed === "number" ? data.refreshed : 0;
}
