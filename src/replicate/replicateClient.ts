/** Thin invoke wrappers for the Rust Replicate catalog — no domain logic. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ReplicateTokenStatus = {
  configured: boolean;
  preview?: string | null;
};

export type ReplicateCrawlStatus = "idle" | "running" | "paused";

export type ReplicateCrawlCheckpoint = {
  status: ReplicateCrawlStatus;
  phase: string;
  nextUrl?: string | null;
  pagesDone: number;
  modelsMerged: number;
  startedAt?: number | null;
  updatedAt?: number | null;
  lastError?: string | null;
  resumable: boolean;
};

export type ReplicateCatalogMeta = {
  lastFullSyncAt?: number | null;
  lastIncrementalAt?: number | null;
  newestSeenVersionAt?: string | null;
  newestSeenCreatedAt?: string | null;
  modelCount: number;
  lastError?: string | null;
};

export type ReplicateCacheStats = {
  modelCount: number;
  meta: ReplicateCatalogMeta;
  checkpoint: ReplicateCrawlCheckpoint;
  tokenConfigured: boolean;
  crawlRunning: boolean;
};

export type ReplicateModelRow = {
  owner: string;
  name: string;
  description?: string | null;
  runCount: number;
  coverImageUrl?: string | null;
  latestVersionId?: string | null;
  latestVersionCreatedAt?: string | null;
  modelCreatedAt?: string | null;
  features: string[];
  schemaCached: boolean;
  url?: string | null;
  enabled: boolean;
};

export type ReplicateModelListPage = {
  rows: ReplicateModelRow[];
  total: number;
  offset: number;
  limit: number;
  /** Present when BE measured the list call (cold index load / sort). */
  timingMs?: {
    total: number;
    indexLoad: number;
    sort: number;
    cacheHit: boolean;
  } | null;
};

export type ReplicateInputField = {
  name: string;
  title?: string | null;
  typeName: string;
  required: boolean;
  description?: string | null;
  format?: string | null;
  defaultValue?: unknown;
  enumValues?: string[] | null;
  minimum?: number | null;
  maximum?: number | null;
  fileLike: boolean;
  /** Array whose items are URI/file inputs. */
  arrayItemFileLike: boolean;
};

export type ReplicateModelDetail = {
  owner: string;
  name: string;
  description?: string | null;
  runCount: number;
  coverImageUrl?: string | null;
  latestVersionId?: string | null;
  features: string[];
  schemaCached: boolean;
  enabled: boolean;
  inputs: ReplicateInputField[];
  url?: string | null;
  raw: unknown;
};

export type ReplicateProgressEvent = {
  phase: string;
  page: number;
  fetched: number;
  merged: number;
  status: string;
  message?: string | null;
  error?: string | null;
  done: boolean;
};

export type ReplicateRunProgressEvent = {
  predictionId?: string | null;
  owner: string;
  name: string;
  status: string;
  message?: string | null;
  error?: string | null;
  localPaths: string[];
  done: boolean;
};

export type ReplicateRunResult = {
  predictionId: string;
  owner: string;
  name: string;
  status: string;
  outputUrls: string[];
  localPaths: string[];
  outputPreview?: string | null;
  runDir: string;
  error?: string | null;
};

export async function replicateTokenStatus(): Promise<ReplicateTokenStatus> {
  return invoke("replicate_token_status");
}

export async function replicateTokenSet(
  token: string,
): Promise<ReplicateTokenStatus> {
  return invoke("replicate_token_set", { token });
}

export async function replicateTokenClear(): Promise<ReplicateTokenStatus> {
  return invoke("replicate_token_clear");
}

export async function replicateCacheStats(): Promise<ReplicateCacheStats> {
  return invoke("replicate_cache_stats");
}

export async function replicateModelsListCached(opts?: {
  query?: string;
  features?: string[];
  /** BE sort: runs_desc | runs_asc | owner_asc | owner_desc | name_asc | name_desc | owner_name_asc */
  sort?: string;
  offset?: number;
  /** Omit or 0 = return all matching rows (for virtual lists). */
  limit?: number | null;
}): Promise<ReplicateModelListPage> {
  return invoke("replicate_models_list_cached", {
    query: opts?.query ?? null,
    features: opts?.features ?? null,
    sort: opts?.sort ?? null,
    offset: opts?.offset ?? 0,
    limit: opts?.limit === undefined ? null : opts.limit,
  });
}

export async function replicateModelGet(
  owner: string,
  name: string,
): Promise<ReplicateModelDetail | null> {
  return invoke("replicate_model_get", { owner, name });
}

export async function replicateModelSetEnabled(
  owner: string,
  name: string,
  enabled: boolean,
): Promise<ReplicateModelDetail> {
  return invoke("replicate_model_set_enabled", { owner, name, enabled });
}

export async function replicateModelsListEnabled(): Promise<string[]> {
  return invoke("replicate_models_list_enabled");
}

export async function replicateModelsCrawlStart(
  resume = false,
): Promise<ReplicateCacheStats> {
  return invoke("replicate_models_crawl_start", { resume });
}

export async function replicateModelsCrawlPause(): Promise<ReplicateCacheStats> {
  return invoke("replicate_models_crawl_pause");
}

export async function replicateModelsCrawlCancel(): Promise<ReplicateCacheStats> {
  return invoke("replicate_models_crawl_cancel");
}

export async function replicateModelsCheckNew(): Promise<ReplicateCacheStats> {
  return invoke("replicate_models_check_new");
}

export async function replicateModelUpdate(
  owner: string,
  name: string,
): Promise<ReplicateModelDetail> {
  return invoke("replicate_model_update", { owner, name });
}

export async function replicateModelRun(
  owner: string,
  name: string,
  input: Record<string, unknown>,
  localFiles?: Record<string, string | string[]>,
): Promise<ReplicateRunResult> {
  return invoke("replicate_model_run", {
    owner,
    name,
    input,
    localFiles: localFiles ?? null,
  });
}

export async function replicateModelRunCancel(): Promise<void> {
  return invoke("replicate_model_run_cancel");
}

/** OS file dialog. `kind`: image | audio | video | any. Returns null if cancelled. */
export async function replicatePickLocalFile(
  kind: "image" | "audio" | "video" | "any" = "any",
): Promise<string | null> {
  return invoke("replicate_pick_local_file", { kind });
}

export type ReplicatePredictionListRow = {
  predictionId: string;
  owner: string;
  name: string;
  version?: string | null;
  status: string;
  error?: string | null;
  createdAt?: string | null;
  predictTime?: number | null;
  totalTime?: number | null;
  hasLocalOutputs: boolean;
  thumbPath?: string | null;
  audioPath?: string | null;
  updatedAt: number;
};

export type ReplicatePredictionRecord = {
  predictionId: string;
  owner: string;
  name: string;
  version?: string | null;
  status: string;
  input: Record<string, unknown>;
  outputUrls: string[];
  localPaths: string[];
  error?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  predictTime?: number | null;
  totalTime?: number | null;
  outputPreview?: string | null;
  savedAt: number;
  updatedAt: number;
  runDir: string;
  prediction?: unknown;
};

export type ReplicatePredictionDetail = {
  record: ReplicatePredictionRecord;
};

export async function replicatePredictionsList(opts?: {
  status?: string | null;
  query?: string | null;
}): Promise<ReplicatePredictionListRow[]> {
  return invoke("replicate_predictions_list", {
    status: opts?.status ?? null,
    query: opts?.query ?? null,
  });
}

export async function replicatePredictionGet(
  predictionId: string,
): Promise<ReplicatePredictionDetail | null> {
  return invoke("replicate_prediction_get", { predictionId });
}

export async function listenReplicateModelsProgress(
  handler: (ev: ReplicateProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ReplicateProgressEvent>("replicate-models-progress", (e) => {
    handler(e.payload);
  });
}

export async function listenReplicateRunProgress(
  handler: (ev: ReplicateRunProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ReplicateRunProgressEvent>("replicate-run-progress", (e) => {
    handler(e.payload);
  });
}
