import {
  partitionStoredProjects,
  repairMalformedTimelineClips,
  nextProjectDocumentRevision,
  saveStoredProjectsPreservingCorrupt,
  type CorruptStoredProject,
  type StoredProject,
} from "./projectStore";
import {
  markProjectUsageStale,
  repairProjectUsage,
  replaceProjectUsage,
} from "./projectFolderClient";
import {
  isMembershipMirrorStaleError,
  mirrorProjectFolderMembership,
} from "./projectFolderMembership";
import { collectProjectAssetUsage } from "./projectUsage";
import { existingCreationIds, getCreations } from "../library/catalogClient";
import { listFolders } from "../library/folderClient";
import {
  collectCabinetMemberIdsFromCovers,
  isProjectOwnedCreation,
  projectCabinetCoverIdsInFolder,
} from "./projectOwnership";

let mutationTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(work, work);
  mutationTail = result.catch(() => undefined);
  return result;
}

function revisionOf(project: StoredProject): string {
  const revision = project.documentRevision?.trim();
  if (!revision) {
    throw new Error(`Project ${project.id} has no document revision`);
  }
  return revision;
}

type MutationSnapshot = {
  projects: StoredProject[];
  corrupt: CorruptStoredProject[];
  orderedIds: string[];
};

function loadMutationSnapshot(): MutationSnapshot {
  return partitionStoredProjects();
}

function assertUpdaterDidNotTouchCorrupt(
  next: StoredProject[],
  corrupt: readonly CorruptStoredProject[],
): void {
  if (corrupt.length === 0) return;
  const corruptIds = new Set(corrupt.map((row) => row.id));
  for (const project of next) {
    if (corruptIds.has(project.id)) {
      throw new Error(
        `Cannot save project ${project.id}: it is corrupt and must be repaired first`,
      );
    }
  }
}

async function repairUsageIndexes(
  projects: readonly StoredProject[],
): Promise<void> {
  for (const project of projects) {
    await repairProjectUsage(
      project.id,
      revisionOf(project),
      collectProjectAssetUsage(project),
    );
  }
}

export function initializeProjectUsageIndexes(
  projects: readonly StoredProject[],
): Promise<void> {
  return enqueue(() => repairUsageIndexes(projects));
}

/**
 * Run a safety-sensitive Library mutation only after strictly reading every
 * healthy project and rebuilding its native usage snapshot. Corrupt siblings
 * are skipped (they must be repaired before their refs are trusted).
 */
export function withStrictProjectAudit<T>(
  work: (projects: readonly StoredProject[]) => Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const { projects } = loadMutationSnapshot();
    await repairUsageIndexes(projects);
    return work(projects);
  });
}

async function loadCabinetMembersByProject(
  projects: readonly StoredProject[],
): Promise<Map<string, Set<string>>> {
  const coverIds = [
    ...new Set(
      projects.flatMap((project) => projectCabinetCoverIdsInFolder(project)),
    ),
  ];
  const covers =
    coverIds.length > 0 ? await getCreations(coverIds) : [];
  const coversById = new Map(covers.map((cover) => [cover.id, cover]));
  const out = new Map<string, Set<string>>();
  for (const project of projects) {
    const projectCovers = projectCabinetCoverIdsInFolder(project)
      .map((id) => coversById.get(id))
      .filter((cover): cover is NonNullable<typeof cover> => Boolean(cover));
    out.set(
      project.id,
      collectCabinetMemberIdsFromCovers(project, projectCovers),
    );
  }
  return out;
}

async function persistStoredProjects(
  snapshot: MutationSnapshot,
  updater: (projects: StoredProject[]) => StoredProject[],
  options?: {
    allowLegacyOutsideTransition?: boolean;
    leaveStaleOnSaveFailure?: boolean;
    allowExistingStaleBarrier?: boolean;
    allowMissingCreationIds?: boolean;
  },
): Promise<StoredProject[]> {
    const previous = snapshot.projects;
    const proposed = updater(previous);
    assertUpdaterDidNotTouchCorrupt(proposed, snapshot.corrupt);
    const previousById = new Map(previous.map((project) => [project.id, project]));
    const changedCandidates = proposed.filter((project) => {
      const before = previousById.get(project.id) ?? null;
      return !(before && JSON.stringify(before) === JSON.stringify(project));
    });
    if (changedCandidates.length === 0) return previous;

    const cabinetMembersByProject = await loadCabinetMembersByProject(
      changedCandidates,
    );

    const changed: Array<{ previous: StoredProject | null; next: StoredProject }> = [];
    const newlyRequiredCreationIds = new Set<string>();
    const next = proposed.map((project) => {
      const before = previousById.get(project.id) ?? null;
      if (before && JSON.stringify(before) === JSON.stringify(project)) {
        return before;
      }
      const nextMembers = new Set(project.creationIds);
      const previousMembers = new Set(before?.creationIds ?? []);
      const previousReferences = new Set(
        before ? collectProjectAssetUsage(before).map((row) => row.creationId) : [],
      );
      const cabinetMembers =
        cabinetMembersByProject.get(project.id) ?? new Set<string>();
      for (const creationId of nextMembers) {
        if (!previousMembers.has(creationId)) {
          newlyRequiredCreationIds.add(creationId);
        }
      }
      for (const usage of collectProjectAssetUsage(project)) {
        if (!previousReferences.has(usage.creationId)) {
          newlyRequiredCreationIds.add(usage.creationId);
        }
        if (isProjectOwnedCreation(project, usage.creationId, cabinetMembers)) {
          continue;
        }
        const isPreservedLegacyOutsideReference =
          Boolean(before) &&
          previousReferences.has(usage.creationId) &&
          !previousMembers.has(usage.creationId);
        if (
          !isPreservedLegacyOutsideReference &&
          options?.allowLegacyOutsideTransition !== true
        ) {
          const projectTitle = project.title.trim() || "Untitled project";
          throw new Error(
            `Cannot save “${projectTitle}” clip “${usage.usageOwnerLabel}”: creation ${usage.creationId} is outside the project folder`,
          );
        }
      }
      const revised = {
        ...project,
        schemaVersion: 2 as const,
        documentRevision: nextProjectDocumentRevision(),
        updatedAt: new Date().toISOString(),
      };
      changed.push({ previous: before, next: revised });
      return revised;
    });
    if (changed.length === 0) return previous;

    // Global Library deletion uses this same queue. Verifying new ownership
    // and references here means a generation/import result cannot be deleted
    // between its catalog check and the project-document commit.
    if (newlyRequiredCreationIds.size > 0 && options?.allowMissingCreationIds !== true) {
      const required = [...newlyRequiredCreationIds];
      const existing = new Set(await existingCreationIds(required));
      const missing = required.filter((creationId) => !existing.has(creationId));
      if (missing.length > 0) {
        throw new Error(
          `Cannot save the project because ${missing.length} Library file(s) no longer exist: ${missing.join(", ")}`,
        );
      }
    }

    for (const row of changed) {
      await markProjectUsageStale(
        row.next.id,
        row.previous ? revisionOf(row.previous) : null,
        revisionOf(row.next),
        options?.allowExistingStaleBarrier === true,
      );
    }

    const remainingCorrupt = snapshot.corrupt.filter(
      (row) => !next.some((project) => project.id === row.id),
    );

    try {
      saveStoredProjectsPreservingCorrupt(
        next,
        remainingCorrupt,
        snapshot.orderedIds,
      );
    } catch (error) {
      if (options?.leaveStaleOnSaveFailure !== true) {
        for (const row of changed) {
          if (!row.previous) continue;
          await replaceProjectUsage(
            row.previous.id,
            revisionOf(row.previous),
            collectProjectAssetUsage(row.previous),
          ).catch(() => undefined);
        }
      }
      throw error;
    }

    for (const row of changed) {
      await replaceProjectUsage(
        row.next.id,
        revisionOf(row.next),
        collectProjectAssetUsage(row.next),
      );
    }
    return next;
}

export function mutateStoredProjects(
  updater: (projects: StoredProject[]) => StoredProject[],
  options?: { allowLegacyOutsideTransition?: boolean },
): Promise<StoredProject[]> {
  return enqueue(async () => {
    const persistOptions = {
      ...options,
      allowExistingStaleBarrier:
        options?.allowLegacyOutsideTransition === true,
    };
    try {
      return await persistStoredProjects(
        loadMutationSnapshot(),
        updater,
        persistOptions,
      );
    } catch (error) {
      if (!isMembershipMirrorStaleError(error)) throw error;
      const folders = await listFolders();
      return persistStoredProjects(
        loadMutationSnapshot(),
        (projects) => updater(mirrorProjectFolderMembership(projects, folders)),
        {
          ...persistOptions,
          allowExistingStaleBarrier: true,
          // Native membership already moved; cabinet members may sit outside
          // creationIds until this remirror lands.
          allowLegacyOutsideTransition: true,
        },
      );
    }
  });
}

/**
 * Drop malformed timeline clips on a corrupt project after user confirmation,
 * then persist with opaque sibling rows preserved.
 */
export function repairCorruptProjectTimeline(id: string): Promise<StoredProject> {
  return enqueue(async () => {
    const snapshot = loadMutationSnapshot();
    const corrupt = snapshot.corrupt.find((row) => row.id === id);
    if (!corrupt) {
      const healthy = snapshot.projects.find((project) => project.id === id);
      if (healthy) return healthy;
      throw new Error(`Stored project ${id} was not found`);
    }
    const repaired = repairMalformedTimelineClips(corrupt.raw);
    const remainingCorrupt = snapshot.corrupt.filter((row) => row.id !== id);
    const nextHealthy = [
      ...snapshot.projects.filter((project) => project.id !== id),
      repaired,
    ];
    await markProjectUsageStale(repaired.id, null, revisionOf(repaired), true);
    saveStoredProjectsPreservingCorrupt(
      nextHealthy,
      remainingCorrupt,
      snapshot.orderedIds,
    );
    await replaceProjectUsage(
      repaired.id,
      revisionOf(repaired),
      collectProjectAssetUsage(repaired),
    );
    return repaired;
  });
}

/**
 * Serialize a checked native membership/delete transaction and its one-way
 * project JSON mirror. Usage is rebuilt before native mutation, and no project
 * save can start until the returned membership has been persisted.
 */
export function mutateStoredProjectsWithNativeMutation<T>(
  nativeMutation: (projects: readonly StoredProject[]) => Promise<T>,
  updater: (projects: StoredProject[], result: T) => StoredProject[],
  options?: {
    allowMissingCreationIds?: boolean;
    /** After native membership already committed; outside refs may remain. */
    allowLegacyOutsideTransition?: boolean;
  },
): Promise<{ result: T; projects: StoredProject[] }> {
  return enqueue(async () => {
    const snapshot = loadMutationSnapshot();
    await repairUsageIndexes(snapshot.projects);
    const result = await nativeMutation(snapshot.projects);
    const projects = await persistStoredProjects(
      snapshot,
      (current) => updater(current, result),
      {
        leaveStaleOnSaveFailure: true,
        allowExistingStaleBarrier: true,
        allowMissingCreationIds: options?.allowMissingCreationIds,
        allowLegacyOutsideTransition: options?.allowLegacyOutsideTransition,
      },
    );
    await repairUsageIndexes(projects);
    return { result, projects };
  });
}

/**
 * Mirror native folder membership into project JSON. Always reads current
 * folders inside the mutation queue — event payloads can predate a later
 * collapse/remove in the same generate/sync burst.
 */
export function mirrorStoredProjectsAfterNativeMembership(
  updater?: (projects: StoredProject[]) => StoredProject[],
): Promise<StoredProject[]> {
  return enqueue(async () => {
    const folders = await listFolders();
    const projects = await persistStoredProjects(
      loadMutationSnapshot(),
      (current) => {
        const mirrored = mirrorProjectFolderMembership(current, folders);
        return updater ? updater(mirrored) : mirrored;
      },
      {
        leaveStaleOnSaveFailure: true,
        allowExistingStaleBarrier: true,
        allowMissingCreationIds: true,
        // Native already moved membership; timeline refs may become outside.
        allowLegacyOutsideTransition: true,
      },
    );
    await repairUsageIndexes(projects);
    return projects;
  });
}

/** Serialize Library membership changes with project-document writes. */
export function withProjectMutationLock<T>(work: () => Promise<T>): Promise<T> {
  return enqueue(work);
}
