import { invokeOk, type AgentManifest } from "./agentClient";

type LookupResult = {
  found?: Array<{ id: string; title: string; localPath?: string | null }>;
};

/**
 * Delete tracked creations plus any leftover rows that still match this run
 * (imports, groups, recaptures). Throws if matching catalog rows remain.
 */
export async function sweepTestCreations(
  agent: AgentManifest,
  opts: {
    ids?: Array<string | null | undefined>;
    titleContains?: string[];
    pathContains?: string[];
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

  const ids = [...collected];

  // Delete the project first. Timeline usage blocks cloud.delete while the
  // document still references the spoken file and the lip-sync clip.
  if (opts.projectId) {
    await invokeOk(agent, "project.delete", { id: opts.projectId });
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

  const leftover: string[] = [];
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
  const remaining = [...new Set(leftover)];
  if (remaining.length) {
    throw new Error(`teardown left catalog rows: ${remaining.join(", ")}`);
  }
}
