import { createAuthedSdk, ensureAccessToken } from "../auth/session";
import {
  downloadThumbs,
  fillThumbAndPushToCloud,
  invalidateThumbs,
  localFitPlan,
  pushLocalFitToCloud,
  type LocalFitTarget,
} from "../library/catalogClient";
import type { RepairBatchResult } from "../sdk/parascene";
import type { SyncItemEvent } from "./syncActivity";
import { syncCreationsManifest } from "./manifestSync";

export type CloudRepairSummary = {
  group: RepairBatchResult;
  fit: RepairBatchResult;
  thumbsRedownloaded: number;
  localFilled: number;
  uploadedOnly: number;
};

function idsFromUpdated(updated: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const row of updated) {
    const id = row.id;
    if (typeof id === "number" || typeof id === "string") {
      out.push(String(id));
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stay under api-library-maintenance (~180 writes/min) during long repair runs. */
const BATCH_PACING_MS = 400;
const UPLOAD_PACING_MS = 350;

function emptyRepair(): RepairBatchResult {
  return {
    updated: [],
    skipped: [],
    updated_count: 0,
    skipped_count: 0,
  };
}

function emitRepair(
  onItem: ((event: SyncItemEvent) => void) | undefined,
  event: Omit<SyncItemEvent, "kind"> & { kind?: string },
): void {
  onItem?.({
    ...event,
    kind: "repair",
  });
}

/** Let React paint Activity rows between items (setState batches otherwise). */
async function emitRepairLive(
  onItem: ((event: SyncItemEvent) => void) | undefined,
  event: Omit<SyncItemEvent, "kind"> & { kind?: string },
): Promise<void> {
  emitRepair(onItem, event);
  await sleep(0);
}

/**
 * Sync-page cloud repair — local-first to avoid API hammering:
 * 1) Fix group aspect ratios (server; one batch)
 * 2) Scan local catalog for square/mismatched thumbs vs media aspect
 * 3) Regenerate from local media + upload fit, or upload an existing `.fit.jpg`
 * 4) Server fit repair only for leftovers without local media
 * 5) Light resync + re-download for server-updated ids
 *
 * Activity rows are emitted as each item is worked (not bulk at start/end).
 */
export async function runCloudLibraryRepair(opts?: {
  fitBatchLimit?: number;
  onPhase?: (phase: string) => void;
  onWait?: (ms: number) => void;
  onItem?: (event: SyncItemEvent) => void;
}): Promise<CloudRepairSummary> {
  await ensureAccessToken();
  const sdk = createAuthedSdk();
  const fitBatchLimit = opts?.fitBatchLimit ?? 25;
  const onWait = opts?.onWait;
  const onItem = opts?.onItem;

  opts?.onPhase?.("group-aspect");
  const group = await sdk.repairGroupAspect({
    limit: 100,
    onWait,
  });
  if (group.updated_count > 0) {
    await emitRepairLive(onItem, {
      id: "group-aspect",
      title: `Group aspects (${group.updated_count})`,
      state: "done",
      detail: `Updated ${group.updated_count} group aspect ratios`,
    });
  }

  opts?.onPhase?.("local-fit-plan");
  const plan = await localFitPlan();
  const fitAgg = emptyRepair();
  let localFilled = 0;
  let uploadedOnly = 0;
  const touchedIds = new Set<string>();

  opts?.onPhase?.("local-fill");
  for (const target of plan.regenerate) {
    await workLocalTarget(target, "regenerate", {
      onItem,
      onWait,
      onDone: () => {
        localFilled += 1;
        touchedIds.add(target.id);
      },
    });
    await sleep(UPLOAD_PACING_MS);
  }

  opts?.onPhase?.("upload-existing-fit");
  for (const target of plan.uploadOnly) {
    await workLocalTarget(target, "upload", {
      onItem,
      onWait,
      onDone: () => {
        uploadedOnly += 1;
        touchedIds.add(target.id);
      },
    });
    await sleep(UPLOAD_PACING_MS);
  }

  opts?.onPhase?.("fit-thumbnails");
  const cloudTargets = plan.cloudRepair.filter((t) => !touchedIds.has(t.id));
  for (let i = 0; i < cloudTargets.length; i += fitBatchLimit) {
    const slice = cloudTargets.slice(i, i + fitBatchLimit);
    for (const target of slice) {
      await emitRepairLive(onItem, {
        id: target.id,
        title: target.title,
        state: "active",
        detail: "Cloud fit repair",
      });
    }
    try {
      const batch = await sdk.repairFitThumbnails({
        ids: slice.map((t) => t.id),
        limit: slice.length,
        force: true,
        onWait,
      });
      fitAgg.updated.push(...batch.updated);
      fitAgg.skipped.push(...batch.skipped);
      fitAgg.updated_count += batch.updated_count;
      fitAgg.skipped_count += batch.skipped_count;

      const updatedIds = new Set(idsFromUpdated(batch.updated));
      const skippedById = new Map<string, string>();
      for (const row of batch.skipped) {
        const id =
          typeof row.id === "number" || typeof row.id === "string"
            ? String(row.id)
            : null;
        if (!id) continue;
        const reason =
          typeof row.reason === "string" && row.reason.trim()
            ? row.reason.trim()
            : "Skipped";
        skippedById.set(id, reason);
      }

      for (const target of slice) {
        if (updatedIds.has(target.id)) {
          touchedIds.add(target.id);
          await emitRepairLive(onItem, {
            id: target.id,
            title: target.title,
            state: "done",
            detail: "Cloud fit generated",
          });
        } else if (skippedById.has(target.id)) {
          await emitRepairLive(onItem, {
            id: target.id,
            title: target.title,
            state: "skipped",
            detail: skippedById.get(target.id) || "Skipped",
          });
        } else {
          await emitRepairLive(onItem, {
            id: target.id,
            title: target.title,
            state: "skipped",
            detail: "No change",
          });
        }
      }
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      for (const target of slice) {
        await emitRepairLive(onItem, {
          id: target.id,
          title: target.title,
          state: "failed",
          detail,
        });
      }
    }
    if (i + fitBatchLimit < cloudTargets.length) {
      await sleep(BATCH_PACING_MS);
    }
  }

  opts?.onPhase?.("resync");
  await syncCreationsManifest();

  opts?.onPhase?.("redownload-thumbs");
  const serverUpdated = idsFromUpdated(fitAgg.updated);
  let thumbsRedownloaded = 0;
  if (serverUpdated.length > 0) {
    await invalidateThumbs(serverUpdated);
    const summary = await downloadThumbs(serverUpdated);
    thumbsRedownloaded = summary.downloaded;
  }

  return {
    group,
    fit: fitAgg,
    thumbsRedownloaded,
    localFilled,
    uploadedOnly,
  };
}

async function workLocalTarget(
  target: LocalFitTarget,
  mode: "regenerate" | "upload",
  opts: {
    onItem?: (event: SyncItemEvent) => void;
    onWait?: (ms: number) => void;
    onDone: () => void;
  },
): Promise<void> {
  const detailActive =
    mode === "regenerate"
      ? "Rebuilding local fit + upload"
      : "Uploading existing local fit";
  const detailDone =
    mode === "regenerate" ? "Local fit uploaded" : "Existing fit uploaded";

  await emitRepairLive(opts.onItem, {
    id: target.id,
    title: target.title,
    state: "active",
    detail: detailActive,
  });
  try {
    if (mode === "regenerate") {
      const creation = await fillThumbAndPushToCloud(target.id, {
        onWait: opts.onWait,
      });
      opts.onDone();
      await emitRepairLive(opts.onItem, {
        id: target.id,
        title: creation.title || target.title,
        state: "done",
        detail: detailDone,
      });
    } else {
      await pushLocalFitToCloud(target.id, { onWait: opts.onWait });
      opts.onDone();
      await emitRepairLive(opts.onItem, {
        id: target.id,
        title: target.title,
        state: "done",
        detail: detailDone,
      });
    }
  } catch (e: unknown) {
    await emitRepairLive(opts.onItem, {
      id: target.id,
      title: target.title,
      state: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
