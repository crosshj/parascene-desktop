import { inspectWwwCreation } from "../agent/inspectCreation";
import { deleteLocal, getCreation } from "../library/catalogClient";
import { isLocalOnlyCreation } from "../library/creationFilters";
import {
  groupSourceCreationIds,
  isGroupCreation,
} from "../library/creationFlags";
import { removeFromFolder } from "../library/folderClient";
import { isSeedLibraryCreationId } from "../library/seedLibraryCreations";
import {
  deleteCreationViaService,
  getRemoteCreation,
  ungroupCreationsViaService,
} from "../services/parasceneCatalog";
import { isParasceneCreationId } from "./projectV2";
import { getProjectV2, patchProjectV2 } from "./projectV2Client";

export type ProjectWipeProgress = (message: string) => void;

/** Child ids to wipe. Never the project row or seed `28006`. */
export function projectWipeChildIds(
  creationIds: readonly string[],
  parasceneProjectId?: string | null,
): string[] {
  const para = parasceneProjectId?.trim() ?? "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of creationIds) {
    const id = raw.trim();
    if (!id || id === para || isSeedLibraryCreationId(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 404/410 or a missing catalog row — not a network/auth failure. */
export function isGoneError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/\((404|410)\)/.test(message)) return true;
  if (
    /\b(404|410)\b/.test(message) &&
    /not found|gone|does not exist/i.test(message)
  ) {
    return true;
  }
  return /creation .+ not found|does not exist/i.test(message);
}

function report(onProgress: ProjectWipeProgress | undefined, message: string) {
  onProgress?.(message);
}

/**
 * Union of the website costume (`source_creations`), desktop `items[]`
 * (including `local://`), and the local document / folder lists.
 */
export async function collectProjectWipeChildIds(opts: {
  parasceneProjectId?: string | null;
  storedCreationIds?: readonly string[];
  folderMemberIds?: readonly string[];
  onProgress?: ProjectWipeProgress;
}): Promise<string[]> {
  const para = opts.parasceneProjectId?.trim() ?? "";
  const collected: string[] = [
    ...(opts.storedCreationIds ?? []),
    ...(opts.folderMemberIds ?? []),
  ];
  if (!para) return projectWipeChildIds(collected, null);

  report(opts.onProgress, "Looking up files on Parascene…");
  try {
    const row = await getRemoteCreation(para, { view: "www" });
    collected.push(
      ...inspectWwwCreation(row).members.map((member) => member.id),
    );
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }

  try {
    const remote = await getProjectV2(para);
    for (const item of remote.items) {
      if (item.pointer.kind === "creation") {
        collected.push(item.pointer.creationId);
      } else {
        collected.push(item.pointer.assetId);
      }
    }
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }

  return projectWipeChildIds(collected, para);
}

export async function assertWwwChildrenCleared(
  parasceneProjectId: string,
): Promise<void> {
  const para = parasceneProjectId.trim();
  if (!para) return;
  try {
    const row = await getRemoteCreation(para, { view: "www" });
    const leftover = projectWipeChildIds(
      inspectWwwCreation(row).members.map((member) => member.id),
      para,
    );
    if (leftover.length > 0) {
      const n = leftover.length;
      throw new Error(
        `Parascene still lists ${n} file${n === 1 ? "" : "s"} in this project.`,
      );
    }
  } catch (err) {
    if (isGoneError(err)) return;
    throw err;
  }
}

async function dropLocalChild(id: string): Promise<void> {
  try {
    await removeFromFolder([id]);
  } catch {
    /* not filed, or already gone */
  }
  try {
    await deleteLocal(id);
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }
}

async function deleteRemoteChild(id: string): Promise<void> {
  if (!isParasceneCreationId(id)) return;
  const row = await getCreation(id).catch(() => null);
  if (row && isLocalOnlyCreation(row)) return;
  try {
    await deleteCreationViaService(id);
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }
}

/** Delete member Creations locally and on Parascene. Skips seed `28006`. */
export async function purgeProjectChildren(
  ids: readonly string[],
  opts?: { onProgress?: ProjectWipeProgress },
): Promise<void> {
  const queued = new Set(projectWipeChildIds(ids));
  if (queued.size === 0) return;

  report(opts?.onProgress, "Preparing files…");
  for (const id of [...queued]) {
    try {
      const row = await getCreation(id);
      if (!isGroupCreation(row)) continue;
      try {
        const { restoredCreationIds } = await ungroupCreationsViaService(id);
        for (const memberId of restoredCreationIds) {
          if (!isSeedLibraryCreationId(memberId)) queued.add(memberId);
        }
      } catch {
        for (const memberId of groupSourceCreationIds(row)) {
          if (!isSeedLibraryCreationId(memberId)) queued.add(memberId);
        }
      }
    } catch {
      /* local-only or already gone */
    }
  }

  const ordered = [...queued];
  const failures: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i]!;
    report(opts?.onProgress, `Deleting ${i + 1} of ${ordered.length}…`);
    try {
      await deleteRemoteChild(id);
      await dropLocalChild(id);
    } catch (err) {
      failures.push(
        `${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (failures.length > 0) {
    const ok = ordered.length - failures.length;
    throw new Error(
      `Deleted ${ok} of ${ordered.length}. Failed:\n${failures.join("\n")}`,
    );
  }
}

/**
 * Clear every child (www list first), then the caller deletes the project.
 * Throws if a child delete fails or the website costume still lists files.
 */
export async function wipeProjectChildren(opts: {
  parasceneProjectId?: string | null;
  storedCreationIds?: readonly string[];
  folderMemberIds?: readonly string[];
  onProgress?: ProjectWipeProgress;
}): Promise<string[]> {
  const para = opts.parasceneProjectId?.trim() ?? "";
  const members = await collectProjectWipeChildIds(opts);
  if (members.length === 0) {
    if (para) {
      report(opts.onProgress, "Checking Parascene…");
      await assertWwwChildrenCleared(para);
    }
    return [];
  }

  if (para) {
    report(opts.onProgress, "Removing files from the project…");
    const remove = new Set(members.filter((id) => isParasceneCreationId(id)));
    try {
      const remote = await getProjectV2(para);
      for (const item of remote.items) {
        remove.add(
          item.pointer.kind === "creation"
            ? item.pointer.creationId
            : item.pointer.uri,
        );
      }
    } catch (err) {
      if (!isGoneError(err)) throw err;
    }
    if (remove.size > 0) {
      try {
        await patchProjectV2(para, { remove: [...remove] });
      } catch (err) {
        if (!isGoneError(err)) throw err;
      }
    }
  }

  await purgeProjectChildren(members, { onProgress: opts.onProgress });
  if (para) {
    report(opts.onProgress, "Checking Parascene…");
    await assertWwwChildrenCleared(para);
  }
  return members;
}
