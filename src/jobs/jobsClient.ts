/**
 * Thin invoke wrappers over the Rust generation job queue.
 *
 * UI tracks a job UUID and renders backend status — it does not own
 * create/wait/group coordination.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isTerminalJobStatus,
  parseJobJson,
  type CleanupGroupsJobResult,
  type EnqueueJobRequest,
  type EnsureGroupsCheckpoint,
  type EnsureGroupsJobResult,
  type Job,
} from "./types";

export async function enqueueJob(request: EnqueueJobRequest): Promise<Job> {
  return invoke<Job>("jobs_enqueue", { request });
}

export async function getJob(id: string): Promise<Job | null> {
  return invoke<Job | null>("jobs_get", { id });
}

export async function listJobs(opts?: {
  projectId?: string | null;
  status?: string | null;
  limit?: number;
}): Promise<Job[]> {
  return invoke<Job[]>("jobs_list", {
    projectId: opts?.projectId ?? null,
    status: opts?.status ?? null,
    limit: opts?.limit ?? 50,
  });
}

export async function cancelJob(id: string): Promise<Job> {
  return invoke<Job>("jobs_cancel", { id });
}

export function listenJobsUpdated(
  handler: (job: Job) => void,
): Promise<UnlistenFn> {
  return listen<Job>("jobs-updated", (event) => {
    handler(event.payload);
  });
}

export type WatchJobOptions = {
  onUpdate?: (job: Job) => void;
  /**
   * Stops watching (cleans up listeners). Does **not** cancel the backend job
   * unless `cancelOnAbort` is true — so leaving a screen mid-run can resume later.
   */
  signal?: AbortSignal;
  /** When true, aborting `signal` also calls `jobs_cancel`. Default false. */
  cancelOnAbort?: boolean;
  /** Fallback poll while waiting for events (ms). */
  pollMs?: number;
};

/**
 * Resolve when the job reaches a terminal status.
 * Prefers `jobs-updated` events; polls as a safety net if events were missed.
 */
export async function watchJob(
  jobId: string,
  opts?: WatchJobOptions,
): Promise<Job> {
  const pollMs = opts?.pollMs ?? 2_000;
  const cancelOnAbort = opts?.cancelOnAbort === true;
  let current =
    (await getJob(jobId)) ??
    (() => {
      throw new Error(`Job ${jobId} not found`);
    })();
  opts?.onUpdate?.(current);
  if (isTerminalJobStatus(String(current.status))) {
    return current;
  }

  return new Promise<Job>((resolve, reject) => {
    let settled = false;
    let unlisten: UnlistenFn | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      opts?.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (job: Job) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(job);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onAbort = () => {
      if (cancelOnAbort) {
        void cancelJob(jobId).catch(() => {});
        fail(new Error("Cancelled"));
        return;
      }
      // Detach only — backend job keeps running for later resume.
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Detached"));
    };

    const apply = (job: Job) => {
      if (job.id !== jobId) return;
      current = job;
      opts?.onUpdate?.(job);
      if (isTerminalJobStatus(String(job.status))) {
        finish(job);
      }
    };

    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

    void listenJobsUpdated(apply)
      .then((off) => {
        unlisten = off;
      })
      .catch((err) => fail(err));

    timer = setInterval(() => {
      void getJob(jobId)
        .then((job) => {
          if (job) apply(job);
        })
        .catch(() => {
          /* transient */
        });
    }, pollMs);
  });
}

export function checkpointFromJob(job: Job): EnsureGroupsCheckpoint | null {
  return (
    parseJobJson<EnsureGroupsCheckpoint>(job.checkpointJson) ??
    parseJobJson<EnsureGroupsCheckpoint>(job.resultJson)
  );
}

export function ensureResultFromJob(job: Job): EnsureGroupsJobResult | null {
  return parseJobJson<EnsureGroupsJobResult>(job.resultJson);
}

export function cleanupResultFromJob(job: Job): CleanupGroupsJobResult | null {
  const parsed = parseJobJson<CleanupGroupsJobResult>(job.resultJson);
  if (!parsed) return null;
  const deletedIds = Array.isArray(parsed.deletedIds)
    ? parsed.deletedIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  return {
    deletedIds,
    messages: Array.isArray(parsed.messages)
      ? parsed.messages.filter((m): m is string => typeof m === "string")
      : [],
  };
}

export function jobProgressMessages(job: Job): string[] {
  const checkpoint = checkpointFromJob(job);
  if (checkpoint?.messages?.length) return checkpoint.messages;
  const result = ensureResultFromJob(job);
  if (result?.messages?.length) return result.messages;
  const cleanup = cleanupResultFromJob(job);
  if (cleanup?.messages?.length) return cleanup.messages;
  if (job.progressNote) return [job.progressNote];
  return [];
}
