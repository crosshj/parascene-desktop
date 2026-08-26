/**
 * Thin invoke wrappers over the Rust service kernel.
 *
 * UI tracks a handle and renders status — it does not own provider recipes.
 * See docs/PLAN-service-and-forms.md.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  dualPhaseFromActivity,
  isTerminalActivityState,
  progressMessagesFromRun,
  type ServiceDescribe,
  type ServiceDescribeRequest,
  type ServiceHandle,
  type ServiceInvokeRequest,
  type ServiceListEntry,
  type ServiceRun,
} from "./types";

export async function serviceList(): Promise<ServiceListEntry[]> {
  return invoke<ServiceListEntry[]>("service_list");
}

export async function serviceDescribe(
  request: ServiceDescribeRequest,
): Promise<ServiceDescribe> {
  return invoke<ServiceDescribe>("service_describe", { request });
}

export async function serviceInvoke(
  request: ServiceInvokeRequest,
): Promise<ServiceHandle> {
  return invoke<ServiceHandle>("service_invoke", { request });
}

export async function serviceGet(id: string): Promise<ServiceRun | null> {
  return invoke<ServiceRun | null>("service_get", { id });
}

export async function serviceCancel(id: string): Promise<ServiceRun> {
  return invoke<ServiceRun>("service_cancel", { id });
}

export async function serviceListRuns(opts?: {
  projectId?: string | null;
  status?: string | null;
  limit?: number;
}): Promise<ServiceRun[]> {
  return invoke<ServiceRun[]>("service_list_runs", {
    projectId: opts?.projectId ?? null,
    status: opts?.status ?? null,
    limit: opts?.limit ?? 50,
  });
}

/** Same event bus as jobs-updated — kernel reuses the jobs table. */
export function listenServiceUpdated(
  handler: (run: ServiceRun) => void,
): Promise<UnlistenFn> {
  return listen<ServiceRun>("jobs-updated", (event) => {
    handler(event.payload);
  });
}

export type WatchServiceOptions = {
  onUpdate?: (run: ServiceRun) => void;
  /**
   * Stops watching. Does not cancel the backend job unless cancelOnAbort.
   */
  signal?: AbortSignal;
  cancelOnAbort?: boolean;
  pollMs?: number;
};

/**
 * Resolve when a job handle reaches a terminal status.
 * Prefers jobs-updated; polls as a safety net.
 */
export async function watchService(
  handle: ServiceHandle,
  opts?: WatchServiceOptions,
): Promise<ServiceRun> {
  if (handle.mode === "result") {
    throw new Error("watchService requires a job handle");
  }
  return watchServiceRun(handle.id, opts);
}

export async function watchServiceRun(
  runId: string,
  opts?: WatchServiceOptions,
): Promise<ServiceRun> {
  const pollMs = opts?.pollMs ?? 2_000;
  const cancelOnAbort = opts?.cancelOnAbort === true;
  let current =
    (await serviceGet(runId)) ??
    (() => {
      throw new Error(`Service run ${runId} not found`);
    })();
  opts?.onUpdate?.(current);
  if (isTerminalActivityState(String(current.status))) {
    return current;
  }

  return new Promise<ServiceRun>((resolve, reject) => {
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

    const finish = (run: ServiceRun) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(run);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onAbort = () => {
      if (cancelOnAbort) {
        void serviceCancel(runId).catch(() => {});
        fail(new Error("Cancelled"));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Detached"));
    };

    const apply = (run: ServiceRun) => {
      if (run.id !== runId) return;
      current = run;
      opts?.onUpdate?.(run);
      if (isTerminalActivityState(String(run.status))) {
        finish(run);
      }
    };

    if (opts?.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }

    void listenServiceUpdated(apply)
      .then((off) => {
        unlisten = off;
      })
      .catch((err) => fail(err));

    timer = setInterval(() => {
      void serviceGet(runId)
        .then((run) => {
          if (run) apply(run);
        })
        .catch(() => {
          /* transient */
        });
    }, pollMs);
  });
}

export {
  dualPhaseFromActivity,
  progressMessagesFromRun,
  isTerminalActivityState,
};
