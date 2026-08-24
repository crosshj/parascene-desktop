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
  /** Optional display labels keyed by enum value (Generate / curated forms). */
  enumLabels?: Record<string, string> | null;
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
  /** Seconds — Replicate metrics or Blue wall-clock. */
  predictTime?: number | null;
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
  /** BE enabled filter: all (omit) | enabled | disabled */
  enabled?: "all" | "enabled" | "disabled";
  offset?: number;
  /** Omit or 0 = return all matching rows (for virtual lists). */
  limit?: number | null;
}): Promise<ReplicateModelListPage> {
  return invoke("replicate_models_list_cached", {
    query: opts?.query ?? null,
    features: opts?.features ?? null,
    sort: opts?.sort ?? null,
    enabled:
      !opts?.enabled || opts.enabled === "all" ? null : opts.enabled,
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
  requiredFileFields?: string[],
): Promise<ReplicateRunResult> {
  const files = localFiles ?? null;
  return invoke("replicate_model_run", {
    owner,
    name,
    input,
    localFiles: files,
    // JSON backup — some Windows builds arrive with an empty HashMap over IPC.
    localFilesJson: files ? JSON.stringify(files) : null,
    requiredFileFields: requiredFileFields?.filter((f) => f.trim()) ?? null,
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

/** Re-download outputs for a prediction that already succeeded on Replicate. */
export async function replicatePredictionDownload(
  predictionId: string,
): Promise<ReplicateRunResult> {
  return invoke("replicate_prediction_download", { predictionId });
}

/** Poll an existing prediction until terminal, then download outputs. */
export async function replicatePredictionWait(
  predictionId: string,
): Promise<ReplicateRunResult> {
  return invoke("replicate_prediction_wait", { predictionId });
}

/** Delete local Lab history + cached outputs for a prediction. */
export async function replicatePredictionDelete(
  predictionId: string,
): Promise<void> {
  return invoke("replicate_prediction_delete", { predictionId });
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
