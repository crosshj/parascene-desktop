import { leftoverProjectsFromState } from "../src/fixtures/leftoverTestProjects";
import {
  SEED_LIBRARY_CREATION_IDS,
  isSeedLibraryCreationId,
} from "../src/library/seedLibraryCreations";
import {
  agentJson,
  invokeOk,
  loadAgentManifest,
  type AgentManifest,
} from "./agentClient";

function isAgentGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|socket hang up/i.test(message);
}

async function recoverAgent(
  agent: AgentManifest,
  attempt: number,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
  const next = await loadAgentManifest();
  agent.origin = next.origin;
  agent.token = next.token;
  agent.pid = next.pid;
}

/** Teardown only: reload `agent.json` if `tauri dev` bounced mid-suite. */
async function invokeSweep<T>(
  agent: AgentManifest,
  action: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await invokeOk<T>(agent, action, args);
    } catch (error) {
      lastError = error;
      if (!isAgentGone(error)) throw error;
      await recoverAgent(agent, attempt);
    }
  }
  throw lastError;
}

async function readSweepJson<T>(agent: AgentManifest, path: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const { status, body } = await agentJson<T>(agent, path);
      if (status !== 200) throw new Error(`GET ${path} failed (${status})`);
      return body;
    } catch (error) {
      lastError = error;
      if (!isAgentGone(error)) throw error;
      await recoverAgent(agent, attempt);
    }
  }
  throw lastError;
}

type LookupResult = {
  found?: Array<{ id: string; title: string; localPath?: string | null }>;
};

/**
 * Delete tracked creations plus leftover rows / projects that still match
 * this suite (imports, groups, interrupted runs). Throws if matching catalog
 * rows remain.
 *
 * Generated stills are titled with a filename, not the project prefix. Sweep
 * must collect by id and prompt, then re-check those ids after delete.
 * Matching `titleContains` also deletes leftover projects and folders.
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
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      titleContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }
  for (const needle of opts.pathContains ?? []) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      pathContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }
  for (const needle of opts.promptContains ?? []) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      promptContains: needle,
    });
    for (const row of looked.found ?? []) collected.add(row.id);
  }

  const ids = [...collected].filter((id) => !isSeedLibraryCreationId(id));

  const snapshot = await readSweepJson<{
    library?: { folders?: Array<{ id?: string; title?: string; projectId?: string | null }> };
    projects?: Array<{ id?: string; title?: string }>;
    shell?: { openProjectId?: string | null; openProjectTitle?: string | null };
  }>(agent, "/agent/v1/state?scope=all");
  const leftoverProjects = leftoverProjectsFromState(opts.titleContains ?? [], {
    folders: snapshot.library?.folders,
    projects: snapshot.projects,
    openProjectId: snapshot.shell?.openProjectId,
    openProjectTitle: snapshot.shell?.openProjectTitle,
  });
  if (
    snapshot.shell?.openProjectId &&
    leftoverProjects.some((hit) => hit.projectId === snapshot.shell?.openProjectId)
  ) {
    try {
      await invokeSweep(agent, "project.close");
    } catch {
      /* already on the chooser */
    }
  }

  // Delete leftover / this-run projects first. Timeline usage blocks
  // cloud.delete while the document still references the spoken file.
  const projectIds = new Set(
    [opts.projectId, ...leftoverProjects.map((hit) => hit.projectId)].filter(
      (id): id is string => Boolean(id),
    ),
  );
  const folderIds = new Set(
    [opts.folderId, ...leftoverProjects.map((hit) => hit.folderId)].filter(
      (id): id is string => Boolean(id),
    ),
  );
  for (const id of projectIds) {
    try {
      await invokeSweep(agent, "project.delete", { id });
    } catch {
      /* suite may have already deleted the document */
    }
  }
  for (const id of folderIds) {
    try {
      await invokeSweep(agent, "folder.delete", { id });
    } catch {
      /* project.delete often leaves a regular folder, then this removes it */
    }
  }

  if (ids.length) {
    await invokeSweep(agent, "cloud.delete", { ids });
  }

  // Project/folder delete queues cloud folder mutations. Sweep used to ignore
  // folder_pending_ops, so Sync stayed red after an empty Library.
  try {
    const folders = await invokeSweep<{
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
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", { id });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.titleContains ?? []) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      titleContains: needle,
    });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.pathContains ?? []) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      pathContains: needle,
    });
    leftover.push(...(looked.found ?? []).map((row) => row.id));
  }
  for (const needle of opts.promptContains ?? []) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
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

  const after = await readSweepJson<{
    library?: { folders?: Array<{ id?: string; title?: string; projectId?: string | null }> };
    projects?: Array<{ id?: string; title?: string }>;
    shell?: { openProjectId?: string | null; openProjectTitle?: string | null };
  }>(agent, "/agent/v1/state?scope=all");
  const remainingProjects = leftoverProjectsFromState(opts.titleContains ?? [], {
    folders: after.library?.folders,
    projects: after.projects,
    openProjectId: after.shell?.openProjectId,
    openProjectTitle: after.shell?.openProjectTitle,
  });
  if (remainingProjects.length) {
    throw new Error(
      `teardown left projects: ${remainingProjects
        .map((hit) => hit.projectId ?? hit.folderId)
        .join(", ")}`,
    );
  }

  for (const seedId of SEED_LIBRARY_CREATION_IDS) {
    const looked = await invokeSweep<LookupResult>(agent, "library.lookup", {
      id: seedId,
    });
    if (!(looked.found ?? []).some((row) => row.id === seedId)) {
      throw new Error(
        `teardown missing seed Library creation ${seedId} (account avatar). Restore it — do not delete this tile.`,
      );
    }
  }
}
