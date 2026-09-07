import { invokeOk, type AgentManifest } from "./agentClient";
import {
  SEED_LIBRARY_CREATION_IDS,
  isSeedLibraryCreationId,
} from "../src/library/seedLibraryCreations";

type LookupResult = {
  found?: Array<{ id: string; title: string; localPath?: string | null }>;
};

/**
 * Delete tracked creations plus any leftover rows that still match this run
 * (imports, groups, recaptures). Throws if matching catalog rows remain.
 *
 * Generated stills are titled with a filename, not the project prefix. Sweep
 * must collect by id and prompt, then re-check those ids after delete.
 */
export async function sweepTestCreations(
  agent: AgentManifest,
  opts: {
    ids?: Array<string | null | undefined>;
    titleContains?: string[];
    pathContains?: string[];
    promptContains?: string[];
    projectId?: string;
    folderId?: string;
  },
): Promise<void> {
  const collected = new Set<string>();
  for (const id of opts.ids ?? []) {
    if (id) collected.add(id);
  }
  for (const needle of opts.titleContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      titleContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }
  for (const needle of opts.pathContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      pathContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }
  for (const needle of opts.promptContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      promptContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }

  const ids = [...collected].filter((id) => !isSeedLibraryCreationId(id));

  // Delete the project first. Timeline usage blocks cloud.delete while the
  // document still references the spoken file and the lip-sync clip.
  if (opts.projectId) {
    try {
      await invokeOk(agent, "project.delete", { id: opts.projectId });
    } catch {
      /* suite may have already deleted the document */
    }
  }
  if (opts.folderId) {
    try {
      await invokeOk(agent, "folder.delete", { id: opts.folderId });
    } catch {
      /* project.delete often leaves a regular folder, then this removes it */
    }
  }

  if (ids.length) {
    await invokeOk(agent, "cloud.delete", { ids });
  }

  // Project/folder delete queues cloud folder mutations. Sweep used to ignore
  // folder_pending_ops, so Sync stayed red after an empty Library.
  try {
    const folders = await invokeOk<{
      ok?: boolean;
      pendingCount?: number;
      message?: string | null;
    }>(agent, "sync.folders", { dropTitleContains: "agent-test-" });
    if (
      !folders.ok &&
      /agent-test-/i.test(folders.message ?? "")
    ) {
      throw new Error(`teardown left folder ops: ${folders.message}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/agent-test-/i.test(message) || /folder id already exists/i.test(message)) {
      throw error instanceof Error ? error : new Error(message);
    }
  }

  const leftover: string[] = [];
  for (const id of ids) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", { id });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.titleContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      titleContains: needle,
    });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.pathContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      pathContains: needle,
    });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.promptContains ?? []) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      promptContains: needle,
    });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  const remaining = [...new Set(leftover)].filter(
    (id) => !isSeedLibraryCreationId(id),
  );
  if (remaining.length) {
    throw new Error(`teardown left catalog rows: ${remaining.join(", ")}`);
  }

  for (const seedId of SEED_LIBRARY_CREATION_IDS) {
    const looked = await invokeOk<LookupResult>(agent, "library.lookup", {
      id: seedId,
    });
    if (!(looked.found ?? []).some((row) => row.id === seedId)) {
      throw new Error(
        `teardown missing seed Library creation ${seedId} (account avatar). Restore it — do not delete this tile.`,
      );
    }
  }
}
