/**
 * Catalog sync jobs that may already be running in the jobs worker
 * (recovered on launch, started from another screen, or left after leaving Sync).
 */
import { useCallback, useEffect, useState } from "react";
import { listJobs, listenJobsUpdated } from "../jobs/jobsClient";
import { isTerminalJobStatus, type Job } from "../jobs/types";

export type CatalogJobKind = "sync_newest" | "sync_full";
export type CatalogJobMode = "newest" | "full";

export function isCatalogJobKind(kind: string): kind is CatalogJobKind {
  return kind === "sync_newest" || kind === "sync_full";
}

export function isActiveJobStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "waiting";
}

export function catalogJobMode(kind: string): CatalogJobMode | null {
  if (kind === "sync_newest") return "newest";
  if (kind === "sync_full") return "full";
  return null;
}

function activityRank(status: string): number {
  if (status === "running") return 3;
  if (status === "waiting") return 2;
  if (status === "queued") return 1;
  return 0;
}

export function pickActiveCatalogJob<
  T extends { kind: string; status: string; updatedAt?: string },
>(jobs: T[]): T | null {
  const active = jobs.filter(
    (job) =>
      isCatalogJobKind(String(job.kind)) &&
      isActiveJobStatus(String(job.status)),
  );
  if (active.length === 0) return null;
  return [...active].sort((a, b) => {
    const rank = activityRank(String(b.status)) - activityRank(String(a.status));
    if (rank !== 0) return rank;
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  })[0];
}

export function catalogJobHeadline(job: {
  kind: string;
  status: string;
  label?: string | null;
  progressNote?: string | null;
}): { label: string; title: string } {
  const name =
    job.kind === "sync_full"
      ? "Sync full catalog"
      : job.kind === "sync_newest"
        ? "Sync newest"
        : job.label?.trim() || "Catalog sync";
  const note = job.progressNote?.trim();
  if (job.status === "queued") {
    return {
      label: "Queued",
      title: `${name} is waiting for another job`,
    };
  }
  return {
    label: "Background",
    title: note || `${name} running in the background`,
  };
}

async function listActiveJobs(): Promise<Job[]> {
  const [queued, running, waiting] = await Promise.all([
    listJobs({ status: "queued", limit: 50 }),
    listJobs({ status: "running", limit: 20 }),
    listJobs({ status: "waiting", limit: 20 }),
  ]);
  return [...queued, ...running, ...waiting];
}

/** Live catalog job that this Sync visit did not necessarily start. */
export function useBackgroundCatalogJob(): Job | null {
  const [job, setJob] = useState<Job | null>(null);

  const refresh = useCallback(async () => {
    try {
      setJob(pickActiveCatalogJob(await listActiveJobs()));
    } catch {
      /* sqlite / invoke can be briefly busy */
    }
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refresh();
    }, 0);
    let unlisten: (() => void) | undefined;
    void listenJobsUpdated((next) => {
      if (!isCatalogJobKind(String(next.kind))) return;
      if (isActiveJobStatus(String(next.status))) {
        setJob((prev) => pickActiveCatalogJob(prev ? [prev, next] : [next]));
        return;
      }
      if (isTerminalJobStatus(String(next.status))) {
        void refresh();
      }
    }).then((off) => {
      unlisten = off;
    });
    return () => {
      window.clearTimeout(t);
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    const ms = job ? 5_000 : 30_000;
    const id = window.setInterval(() => {
      void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [job, refresh]);

  return job;
}
