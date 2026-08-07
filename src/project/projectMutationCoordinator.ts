import {
  loadStoredProjectsStrict,
  nextProjectDocumentRevision,
  saveStoredProjects,
  type StoredProject,
} from "./projectStore";
import {
  markProjectUsageStale,
  repairProjectUsage,
  replaceProjectUsage,
} from "./projectFolderClient";
import { collectProjectAssetUsage } from "./projectUsage";
import { existingCreationIds } from "../library/catalogClient";

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
 * project and rebuilding its native usage snapshot. The mutation stays under
 * the same lock as project-document writes, so a new reference cannot appear
 * between the audit and the native operation.
 */
export function withStrictProjectAudit<T>(
  work: (projects: readonly StoredProject[]) => Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const projects = loadStoredProjectsStrict();
    await repairUsageIndexes(projects);
    return work(projects);
  });
}

async function persistStoredProjects(
  previous: StoredProject[],
  updater: (projects: StoredProject[]) => StoredProject[],
  options?: {
    allowLegacyOutsideTransition?: boolean;
    leaveStaleOnSaveFailure?: boolean;
    allowExistingStaleBarrier?: boolean;
    allowMissingCreationIds?: boolean;
  },
): Promise<StoredProject[]> {
    const proposed = updater(previous);
    const previousById = new Map(previous.map((project) => [project.id, project]));
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
      for (const creationId of nextMembers) {
        if (!previousMembers.has(creationId)) {
          newlyRequiredCreationIds.add(creationId);
        }
      }
      for (const usage of collectProjectAssetUsage(project)) {
        if (!previousReferences.has(usage.creationId)) {
          newlyRequiredCreationIds.add(usage.creationId);
        }
        if (nextMembers.has(usage.creationId)) continue;
        const isPreservedLegacyOutsideReference =
          Boolean(before) &&
          previousReferences.has(usage.creationId) &&
          !previousMembers.has(usage.creationId);
        if (
          !isPreservedLegacyOutsideReference &&
          options?.allowLegacyOutsideTransition !== true
        ) {
          throw new Error(
            `Cannot save ${usage.usageOwnerLabel}: creation ${usage.creationId} is outside the project folder`,
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

    try {
      saveStoredProjects(next);
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
  return enqueue(() =>
    persistStoredProjects(loadStoredProjectsStrict(), updater, {
      ...options,
      allowExistingStaleBarrier:
        options?.allowLegacyOutsideTransition === true,
    }),
  );
}

/**
 * Serialize a checked native membership/delete transaction and its one-way
 * project JSON mirror. Usage is rebuilt before native mutation, and no project
 * save can start until the returned membership has been persisted.
 */
export function mutateStoredProjectsWithNativeMutation<T>(
  nativeMutation: (projects: readonly StoredProject[]) => Promise<T>,
  updater: (projects: StoredProject[], result: T) => StoredProject[],
  options?: { allowMissingCreationIds?: boolean },
): Promise<{ result: T; projects: StoredProject[] }> {
  return enqueue(async () => {
    const previous = loadStoredProjectsStrict();
    await repairUsageIndexes(previous);
    const result = await nativeMutation(previous);
    const projects = await persistStoredProjects(
      previous,
      (current) => updater(current, result),
      {
        leaveStaleOnSaveFailure: true,
        allowExistingStaleBarrier: true,
        allowMissingCreationIds: options?.allowMissingCreationIds,
      },
    );
    await repairUsageIndexes(projects);
    return { result, projects };
  });
}

/** Mirror a native folder event whose destructive side already committed. */
export function mirrorStoredProjectsAfterNativeMembership(
  updater: (projects: StoredProject[]) => StoredProject[],
): Promise<StoredProject[]> {
  return enqueue(async () => {
    const projects = await persistStoredProjects(
      loadStoredProjectsStrict(),
      updater,
      {
        leaveStaleOnSaveFailure: true,
        allowExistingStaleBarrier: true,
        allowMissingCreationIds: true,
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
