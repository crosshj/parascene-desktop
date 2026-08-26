/**
 * Project group ensure/cleanup via service_invoke (Rust job queue).
 */
import type { Job } from "../jobs/types";
import {
  serviceCancel,
  serviceGet,
  serviceInvoke,
  watchService,
  type WatchServiceOptions,
} from "./serviceClient";
import type { ServiceHandle, ServiceRun } from "./types";

function asJob(run: ServiceRun): Job {
  return run as unknown as Job;
}

export async function invokeEnsureProjectGroups(opts: {
  projectId: string;
  label: string;
  payload: Record<string, unknown>;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "parascene",
    operation: "ensure_project_groups",
    projectId: opts.projectId,
    label: opts.label,
    payload: opts.payload,
  });
}

export async function invokeCleanupProjectGroups(opts: {
  projectId: string;
  label?: string;
  payload: Record<string, unknown>;
}): Promise<ServiceHandle> {
  return serviceInvoke({
    service: "parascene",
    operation: "cleanup_project_groups",
    projectId: opts.projectId,
    label: opts.label ?? "Cleanup project groups",
    payload: opts.payload,
  });
}

export async function getProjectGroupsJob(id: string): Promise<Job | null> {
  const run = await serviceGet(id);
  return run ? asJob(run) : null;
}

export async function watchProjectGroupsJob(
  jobId: string,
  opts?: WatchServiceOptions,
): Promise<Job> {
  const run = await watchService({ mode: "job", id: jobId }, opts);
  return asJob(run);
}

export async function cancelProjectGroupsJobHandle(
  jobId: string,
): Promise<Job> {
  return asJob(await serviceCancel(jobId));
}
