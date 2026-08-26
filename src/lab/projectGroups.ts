/**
 * Project Images / Videos group helpers.
 *
 * Ensure + cleanup run on the Rust generation job queue. Lab only enqueues,
 * watches job UUID status, and writes group ids into the project store.
 */

import { getEnvConfig } from "../auth/session";
import {
  checkpointFromJob,
  cleanupResultFromJob,
  ensureResultFromJob,
  jobProgressMessages,
} from "../jobs/jobsClient";
import type { Job } from "../jobs/types";
import {
  deleteCreationViaService,
  getRemoteCreation,
  groupAppendCreations,
  ungroupCreationsViaService,
} from "../services/parasceneCatalog";
import {
  cancelProjectGroupsJobHandle,
  getProjectGroupsJob,
  invokeCleanupProjectGroups,
  invokeEnsureProjectGroups,
  watchProjectGroupsJob,
} from "../services/projectGroupJobs";
import {
  deleteLocal,
  downloadIds,
  downloadThumbs,
  getCreations,
  listCreations,
} from "../library/catalogClient";
import {
  groupSourceCreationIds,
  isGroupCreation,
} from "../library/creationFlags";
import type { Creation } from "../library/types";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  type ProjectAspectRatio,
} from "../project/aspectRatios";
import type { RemoteCreateImage } from "../sdk/parascene";
import { absolutizeAssetUrl } from "../sdk/parascene";
import {
  desktopCabinetProjectKey,
  desktopProjectGroupMeta,
  desktopProjectGroupPartyName,
  identifyDesktopCabinet,
  matchesDesktopCabinetProject,
  projectGroupKindForRole,
  roleForProjectGroupKind,
  type DesktopProjectGroupRole,
} from "../project/desktopProjectGroups";
import {
  loadStoredProjects,
  replaceStoredProjectAssets,
  setStoredProjectGroupIds,
} from "../project/projectStore";
import {
  mutateStoredProjectsWithNativeMutation,
} from "../project/projectMutationCoordinator";
import {
  addProjectAssets,
  getProjectFolder,
  removeProjectAssetsChecked,
} from "../project/projectFolderClient";
import { listFolders } from "../library/folderClient";
import { collapseCabinetMembersFromProjectFolder } from "../project/cabinetFolderCollapse";
import { ingestRemoteCreation } from "./ingestCreation";
import {
  resolveLabAnimatePrompt,
  resolveLabStillPrompt,
} from "./labPrompts";

/**
 * Ids to send on `POST /api/create/images/group`.
 *
 * Append into an existing cover with `[coverId, ...newMemberIds]` only.
 * Already-filed members are often hidden/"deleted" as standalone rows — sending
 * them again yields `Cannot group deleted creations`.
 */
export function idsForGroupApiCall(
  existingGroupId: string | null,
  newMemberIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const id = String(raw).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  if (existingGroupId) push(existingGroupId);
  for (const id of newMemberIds) push(id);
  return out;
}

/** Candidates that are not the cover and not already filed as members. */
export function newIdsToAppendToGroup(
  existingGroupId: string | null,
  existingMemberIds: readonly string[],
  candidateIds: readonly string[],
): string[] {
  const already = new Set<string>();
  const remember = (raw: string | null | undefined) => {
    const id = String(raw ?? "").trim();
    if (id) already.add(id);
  };
  remember(existingGroupId);
  for (const id of existingMemberIds) remember(id);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidateIds) {
    const id = String(raw).trim();
    if (!id || seen.has(id) || already.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Expected membership after a successful append (for local catalog stamp). */
export function expectedMembersAfterAppend(
  existingMemberIds: readonly string[],
  newMemberIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existingMemberIds, ...newMemberIds]) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Member ids left on a group cover after removing one or more sources. */
export function remainingMembersAfterRemoval(
  existingMemberIds: readonly string[],
  removeIds: readonly string[],
  groupId?: string | null,
): string[] {
  const remove = new Set(
    removeIds.map((id) => String(id).trim()).filter(Boolean),
  );
  const cover = groupId ? String(groupId).trim() : "";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of existingMemberIds) {
    const id = String(raw).trim();
    if (!id || seen.has(id) || remove.has(id) || (cover && id === cover)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export type RemoveGroupMembersResult = {
  deletedMemberIds: string[];
  /** Null when every member was deleted and the group was not recreated. */
  groupId: string | null;
  /** Ids to drop from the open project (deleted members + archived cover). */
  projectCreationIdsToRemove: string[];
  /** New group cover id to add when regrouping produced a fresh cover row. */
  projectCreationIdsToAdd: string[];
};

/**
 * Remove member creations from a desktop project group on Parascene:
 * ungroup → delete targets → regroup survivors (when any remain).
 */
export async function removeMembersFromProjectGroup(opts: {
  projectId: string;
  projectTitle: string;
  kind: ProjectGroupKind;
  groupId: string;
  memberIds: string[];
  onProgress?: (note: string) => void;
}): Promise<RemoveGroupMembersResult> {
  const groupId = String(opts.groupId).trim();
  const toRemove = [
    ...new Set(
      opts.memberIds.map((id) => String(id).trim()).filter(Boolean),
    ),
  ].filter((id) => id !== groupId);
  if (!groupId || toRemove.length === 0) {
    throw new Error("Nothing to remove from group.");
  }

  const existingMembers = await loadExistingMemberIds(groupId);
  const unknown = toRemove.filter((id) => !existingMembers.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Not in group ${groupId}: ${unknown.join(", ")}`,
    );
  }

  const remaining = remainingMembersAfterRemoval(
    existingMembers,
    toRemove,
    groupId,
  );
  const role = roleForProjectGroupKind(opts.kind);
  const groupMeta = desktopProjectGroupMeta({
    role,
    projectId: opts.projectId,
  });
  const partyName = desktopProjectGroupPartyName(opts.projectTitle, role);

  opts.onProgress?.(`Ungrouping ${groupId} on Parascene…`);
  const { restoredCreationIds } = await ungroupCreationsViaService(groupId);
  const restoredSet = new Set(restoredCreationIds);
  for (const id of remainingMembersAfterRemoval(existingMembers, [], groupId)) {
    if (!restoredSet.has(id)) {
      throw new Error(`Ungroup did not restore member ${id}`);
    }
  }

  try {
    await deleteLocal(groupId);
  } catch {
    /* archived cover row may already be gone locally */
  }

  const deletedMemberIds: string[] = [];
  for (const id of toRemove) {
    opts.onProgress?.(`Deleting ${id} on Parascene…`);
    try {
      await deleteCreationViaService(id);
      deletedMemberIds.push(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Parascene delete ${id} failed: ${msg}`);
    }
    try {
      await deleteLocal(id);
    } catch {
      /* local row may already be gone */
    }
  }

  let finalGroupId: string | null = null;
  const projectCreationIdsToAdd: string[] = [];

  if (remaining.length > 0) {
    opts.onProgress?.(
      `Regrouping ${remaining.length} remaining member${remaining.length === 1 ? "" : "s"}…`,
    );
    const grouped = await groupAppendCreations({
      ids: idsForGroupApiCall(null, remaining),
      partyName,
      meta: groupMeta,
    });
    finalGroupId = String(grouped.id);
    const fresh = await getRemoteCreation(finalGroupId);
    const liveMembers = memberIdsFromRemoteGroup(fresh);
    await ingestRemoteCreation(
      withGroupMembership(
        fresh,
        liveMembers.length > 0 ? liveMembers : remaining,
        {
          kind: opts.kind,
          projectId: opts.projectId,
          projectTitle: opts.projectTitle,
        },
      ),
    );
    await downloadIds([finalGroupId]);
    await downloadThumbs([finalGroupId]);
    projectCreationIdsToAdd.push(finalGroupId);
  }

  const projectCreationIdsToRemove = [...toRemove, groupId];

  return {
    deletedMemberIds,
    groupId: finalGroupId,
    projectCreationIdsToRemove,
    projectCreationIdsToAdd,
  };
}

/** Member creation ids from a live Parascene group row. */
export function memberIdsFromRemoteGroup(row: RemoteCreateImage): string[] {
  const meta = row.meta;
  const group =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as { group?: unknown }).group
      : null;
  const g =
    group && typeof group === "object" && !Array.isArray(group)
      ? (group as {
          source_creation_ids?: unknown;
          source_creations?: unknown;
        })
      : null;
  if (!g) return [];

  const fromIds = Array.isArray(g.source_creation_ids)
    ? g.source_creation_ids
        .map((v) =>
          typeof v === "string" || typeof v === "number" ? String(v).trim() : "",
        )
        .filter(Boolean)
    : [];
  if (fromIds.length > 0) return [...new Set(fromIds)];

  const sources = Array.isArray(g.source_creations) ? g.source_creations : [];
  const ids = sources
    .map((source) => {
      if (source && typeof source === "object" && "id" in source) {
        const id = (source as { id?: unknown }).id;
        return typeof id === "string" || typeof id === "number"
          ? String(id).trim()
          : "";
      }
      return typeof source === "string" || typeof source === "number"
        ? String(source).trim()
        : "";
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

/** Cover member id when Parascene marks which source is the group artwork. */
export function coverSourceIdFromRemoteGroup(
  row: RemoteCreateImage,
): string | null {
  const meta = row.meta;
  const group =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as { group?: unknown }).group
      : null;
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const raw = (group as { cover_source_id?: unknown }).cover_source_id;
  if (typeof raw === "string" || typeof raw === "number") {
    const id = String(raw).trim();
    return id || null;
  }
  return null;
}

/**
 * Candidate still ids for i2v: cover member first (usually newest artwork),
 * then remaining members newest→oldest (append order is oldest→newest).
 */
export function stillCandidateIdsFromGroup(opts: {
  memberIds: readonly string[];
  coverSourceId?: string | null;
}): string[] {
  const members = [
    ...new Set(
      opts.memberIds
        .map((raw) => String(raw).trim())
        .filter(Boolean),
    ),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const id = String(raw).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  const cover = opts.coverSourceId?.trim();
  if (cover) push(cover);
  for (const id of [...members].reverse()) push(id);
  return out;
}

function remoteStillUrlFromCreation(c: {
  mediaType?: string | null;
  remoteUrl?: string | null;
  remoteJson?: string | null;
}): string | null {
  const media = String(c.mediaType ?? "").trim().toLowerCase();
  if (media === "video" || media === "audio") return null;
  if (c.remoteUrl?.trim()) return c.remoteUrl.trim();
  if (!c.remoteJson) return null;
  try {
    const raw = JSON.parse(c.remoteJson) as { url?: string; file_path?: string };
    const url = raw.url?.trim() || raw.file_path?.trim() || "";
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("/")) return `https://www.parascene.ai${url}`;
    return url;
  } catch {
    return null;
  }
}

function remoteStillUrlFromApiRow(
  row: RemoteCreateImage,
  origin: string,
): string | null {
  const media = String(row.media_type ?? "").trim().toLowerCase();
  if (media === "video" || media === "audio") return null;
  const raw =
    (typeof row.url === "string" && row.url.trim()) ||
    (typeof row.fit_thumbnail_url === "string" && row.fit_thumbnail_url.trim()) ||
    (typeof row.thumbnail_url === "string" && row.thumbnail_url.trim()) ||
    "";
  if (!raw) return null;
  return absolutizeAssetUrl(raw, origin) ?? raw;
}

/**
 * Resolve the newest Images-group still URL for Lab create i2v (and similar).
 * Prefers `cover_source_id`, then members newest-first, then the group cover URL.
 */
export async function resolveLatestImagesGroupStill(opts: {
  imagesGroupId: string | null;
}): Promise<{ imageUrl: string; sourceId: string }> {
  const groupId = opts.imagesGroupId?.trim() || "";
  if (!groupId) {
    throw new Error("Images group not ready — run Project groups first.");
  }

  const origin = getEnvConfig().baseUrl;
  let memberIds: string[] = [];
  let coverSourceId: string | null = null;
  let coverUrl: string | null = null;

  try {
    const local = await getCreations([groupId]);
    const cover = local[0];
    if (cover) {
      memberIds = groupSourceCreationIds(cover);
      coverUrl = remoteStillUrlFromCreation(cover);
      if (cover.remoteJson) {
        try {
          const parsed = JSON.parse(cover.remoteJson) as RemoteCreateImage;
          coverSourceId = coverSourceIdFromRemoteGroup(parsed);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* fall through to live fetch */
  }

  try {
    const live = await getRemoteCreation(groupId);
    const liveMembers = memberIdsFromRemoteGroup(live);
    if (liveMembers.length > 0) memberIds = liveMembers;
    coverSourceId = coverSourceIdFromRemoteGroup(live) ?? coverSourceId;
    coverUrl = remoteStillUrlFromApiRow(live, origin) ?? coverUrl;
  } catch {
    /* keep local */
  }

  const candidates = stillCandidateIdsFromGroup({ memberIds, coverSourceId });
  if (candidates.length > 0) {
    const localRows = await getCreations(candidates);
    const byId = new Map(localRows.map((row) => [row.id, row]));
    for (const id of candidates) {
      const localUrl = remoteStillUrlFromCreation(byId.get(id) ?? {});
      if (localUrl) return { imageUrl: localUrl, sourceId: id };
      try {
        const live = await getRemoteCreation(id);
        const url = remoteStillUrlFromApiRow(live, origin);
        if (url) return { imageUrl: url, sourceId: id };
      } catch {
        /* try next */
      }
    }
  }

  if (coverUrl) return { imageUrl: coverUrl, sourceId: groupId };

  throw new Error(
    `Images group ${groupId} has no still URL — add/sync an image member first.`,
  );
}

export type ProjectGroupKind = "images" | "videos";

export type EnsureGroupsResult = {
  imagesGroupId: string | null;
  videosGroupId: string | null;
  /** Group cover ids to add to the open project (members stay inside the group). */
  projectCreationIds: string[];
  messages: string[];
  /** Backend job that owned this ensure (for resume / cancel). */
  jobId: string;
};

export type EnsureCheckpoint = {
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  projectCreationIds?: string[];
  /** Creation currently waiting on Parascene (for UI / legacy). */
  pendingCreationId?: string | null;
  /** Durable backend job id. */
  backendJobId?: string | null;
};

export type CleanupGroupsResult = {
  deletedIds: string[];
  cleanedIds: string[];
  localDeletedIds: string[];
  messages: string[];
  jobId: string;
};

export function isCancelledError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /^cancelled$/i.test(msg.trim());
}

/** FE stopped watching; backend job may still be running (leave Lab / remount). */
export function isDetachedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^detached$/i.test(msg.trim());
}

function resolveAspectRatio(value: unknown): ProjectAspectRatio {
  return isProjectAspectRatio(value) ? value : DEFAULT_PROJECT_ASPECT_RATIO;
}

function applyJobCheckpoint(
  job: Job,
  onCheckpoint?: (state: EnsureCheckpoint) => void,
  onProgress?: (note: string) => void,
): void {
  const checkpoint = checkpointFromJob(job);
  if (job.progressNote) onProgress?.(job.progressNote);
  if (!checkpoint && !job.progressNote) return;
  onCheckpoint?.({
    backendJobId: job.id,
    imagesGroupId: checkpoint?.imagesGroupId,
    videosGroupId: checkpoint?.videosGroupId,
    pendingCreationId: checkpoint?.pendingCreationId,
    projectCreationIds: checkpoint?.projectCreationIds,
  });
}

/**
 * Ensure Images and/or Videos party groups via the backend job queue.
 * Mid-run leave/resume is owned by the job UUID (SQLite), not FE polling.
 */
export async function ensureProjectGroups(opts: {
  projectId: string;
  projectTitle: string;
  /** Project creative aspect ratio — used for all minted stills / clips. */
  aspectRatio?: ProjectAspectRatio | string | null;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  /** Still prompt for minting the Images group seed (defaults to Lab suite). */
  stillPrompt?: string | null;
  /** Animate prompt for image→video into Videos group (defaults to Lab suite). */
  animatePrompt?: string | null;
  /**
   * Which side to ensure. Lab Kind selector uses images | videos; omit/`both`
   * keeps the legacy full suite (e.g. resume of older jobs).
   */
  mode?: "images" | "videos" | "both";
  /** Resume waiting on a creation from a previous interrupted run. */
  pendingCreationId?: string | null;
  /** Attach to an already-enqueued backend job instead of minting a new one. */
  backendJobId?: string | null;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
  /** Persist group ids / project assets as soon as each step finishes. */
  onCheckpoint?: (state: EnsureCheckpoint) => void;
}): Promise<EnsureGroupsResult> {
  const aspectRatio = resolveAspectRatio(opts.aspectRatio);
  const stillPrompt = resolveLabStillPrompt(opts.stillPrompt);
  const animatePrompt = resolveLabAnimatePrompt(opts.animatePrompt);
  const mode = opts.mode ?? "both";
  const payload = {
    projectTitle: opts.projectTitle,
    aspectRatio,
    imagesGroupId: opts.imagesGroupId,
    videosGroupId: opts.videosGroupId,
    pendingCreationId: opts.pendingCreationId ?? null,
    stillPrompt,
    animatePrompt,
    mode,
  };
  const label =
    mode === "images"
      ? "Ensure Images group"
      : mode === "videos"
        ? "Ensure Videos group"
        : "Ensure project groups";
  let job: Job;

  if (opts.backendJobId) {
    const existing = await getProjectGroupsJob(opts.backendJobId);
    if (!existing) {
      opts.onProgress?.(
        `Backend job ${opts.backendJobId} missing — starting a fresh ensure.`,
      );
      const handle = await invokeEnsureProjectGroups({
        projectId: opts.projectId,
        label,
        payload,
      });
      if (handle.mode !== "job") {
        throw new Error("ensure_project_groups expected a job handle");
      }
      const fresh = await getProjectGroupsJob(handle.id);
      if (!fresh) {
        throw new Error("ensure_project_groups job missing after invoke");
      }
      job = fresh;
      opts.onProgress?.(`Queued ensure as job ${job.id}.`);
      opts.onCheckpoint?.({ backendJobId: job.id });
    } else {
      job = existing;
      opts.onProgress?.(
        `Attached to backend job ${job.id} (${job.status}).`,
      );
      opts.onCheckpoint?.({ backendJobId: job.id });
      applyJobCheckpoint(job, opts.onCheckpoint, opts.onProgress);
      if (
        job.status === "done" ||
        job.status === "failed" ||
        job.status === "cancelled"
      ) {
        return finalizeEnsureJob(job);
      }
    }
  } else {
    const handle = await invokeEnsureProjectGroups({
      projectId: opts.projectId,
      label,
      payload,
    });
    if (handle.mode !== "job") {
      throw new Error("ensure_project_groups expected a job handle");
    }
    const fresh = await getProjectGroupsJob(handle.id);
    if (!fresh) {
      throw new Error("ensure_project_groups job missing after invoke");
    }
    job = fresh;
    opts.onProgress?.(`Queued ensure as job ${job.id}.`);
    opts.onCheckpoint?.({ backendJobId: job.id });
  }

  try {
    const finalJob = await watchProjectGroupsJob(job.id, {
      signal: opts.signal,
      // Cancel is explicit via cancelProjectGroupsJob — abort only detaches.
      cancelOnAbort: false,
      onUpdate: (updated) => {
        applyJobCheckpoint(updated, opts.onCheckpoint, opts.onProgress);
      },
    });
    return finalizeEnsureJob(finalJob);
  } catch (err) {
    if (isDetachedError(err)) throw err;
    // If cancel won the race, surface as Cancelled.
    if (isCancelledError(err)) throw new Error("Cancelled");
    throw err;
  }
}

function finalizeEnsureJob(job: Job): EnsureGroupsResult {
  if (job.status === "cancelled") {
    throw new Error("Cancelled");
  }
  if (job.status === "failed") {
    const messages = jobProgressMessages(job);
    throw new Error(job.error || messages.join("\n") || "Ensure failed");
  }
  const result = ensureResultFromJob(job);
  if (!result) {
    throw new Error("Ensure finished without a result payload");
  }
  return {
    ...result,
    jobId: job.id,
  };
}

/**
 * Delete the project's Images/Videos groups (and members) via the job queue.
 * Also purges matching rows from the local Library catalog.
 */
export async function cleanupProjectGroups(opts: {
  projectId: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  pendingCreationId?: string | null;
  /** Extra member ids discovered from the local catalog (hints for the job). */
  memberIds?: string[];
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
  /** Fired as soon as the backend job UUID exists (for Cancel). */
  onJobId?: (jobId: string) => void;
}): Promise<CleanupGroupsResult> {
  const handle = await invokeCleanupProjectGroups({
    projectId: opts.projectId,
    payload: {
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      pendingCreationId: opts.pendingCreationId ?? null,
      memberIds: opts.memberIds ?? [],
    },
  });
  if (handle.mode !== "job") {
    throw new Error("cleanup_project_groups expected a job handle");
  }
  opts.onJobId?.(handle.id);
  opts.onProgress?.(`Queued cleanup as job ${handle.id}.`);

  const finalJob = await watchProjectGroupsJob(handle.id, {
    signal: opts.signal,
    cancelOnAbort: false,
    onUpdate: (updated) => {
      if (updated.progressNote) opts.onProgress?.(updated.progressNote);
    },
  });

  if (finalJob.status === "cancelled") {
    throw new Error("Cancelled");
  }
  if (finalJob.status === "failed") {
    throw new Error(finalJob.error || "Cleanup failed");
  }
  const result = cleanupResultFromJob(finalJob);
  if (!result) {
    throw new Error("Cleanup finished without a result payload");
  }
  return {
    deletedIds: result.deletedIds,
    cleanedIds: result.cleanedIds ?? result.deletedIds,
    localDeletedIds: result.localDeletedIds ?? [],
    messages: result.messages,
    jobId: finalJob.id,
  };
}

/** Cancel an in-flight ensure/cleanup job (idempotent). */
export async function cancelProjectGroupsJob(jobId: string | null | undefined): Promise<void> {
  if (!jobId) return;
  try {
    await cancelProjectGroupsJobHandle(jobId);
  } catch {
    /* already gone */
  }
}

export type CabinetCandidate = {
  id: string;
  memberCount: number;
  createdAt: string;
};

/**
 * Pick a single keeper among duplicate cabinet covers.
 * Prefer `preferredId` when present; else most members; else oldest createdAt.
 */
/** True when this cover is this project's Images/Videos cabinet of `role`. */
export function isSameProjectCabinetRole(
  creation: Creation | null | undefined,
  opts: {
    role: DesktopProjectGroupRole;
    projectId?: string | null;
    projectTitle?: string | null;
  },
): boolean {
  const identity = identifyDesktopCabinet(creation);
  if (!identity || identity.role !== opts.role) return false;
  if (matchesDesktopCabinetProject(identity, opts)) return true;
  const wantTitle = opts.projectTitle?.trim() || "";
  return Boolean(
    wantTitle && identity.projectTitle && identity.projectTitle === wantTitle,
  );
}

/**
 * Other Images/Videos covers already in this project's folder.
 * After a regroup those leftovers must be unfiled so only one container remains.
 */
export function siblingProjectCabinetCoverIds(opts: {
  keeperId: string;
  kind: ProjectGroupKind;
  projectId: string;
  projectTitle: string;
  folderMemberIds: readonly string[];
  creationsById: Readonly<Record<string, Creation | undefined>>;
}): string[] {
  const role = roleForProjectGroupKind(opts.kind);
  const keeper = opts.keeperId.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts.folderMemberIds) {
    const id = String(raw).trim();
    if (!id || id === keeper || seen.has(id)) continue;
    if (
      !isSameProjectCabinetRole(opts.creationsById[id], {
        role,
        projectId: opts.projectId,
        projectTitle: opts.projectTitle,
      })
    ) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function pickCabinetKeeper(
  candidates: readonly CabinetCandidate[],
  preferredId?: string | null,
): string | null {
  if (candidates.length === 0) return null;
  const preferred = preferredId?.trim() || "";
  if (preferred && candidates.some((c) => c.id === preferred)) {
    return preferred;
  }
  const sorted = [...candidates].sort((a, b) => {
    if (b.memberCount !== a.memberCount) return b.memberCount - a.memberCount;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return sorted[0]?.id ?? null;
}

/** Catalog covers that look like desktop cabinets for a project + role. */
export function findCabinetCandidatesInCatalog(
  creations: readonly Creation[],
  opts: {
    role: DesktopProjectGroupRole;
    projectId?: string | null;
    projectTitle?: string | null;
  },
): CabinetCandidate[] {
  const out: CabinetCandidate[] = [];
  for (const creation of creations) {
    const identity = identifyDesktopCabinet(creation);
    if (!identity) continue;
    if (!matchesDesktopCabinetProject(identity, opts)) continue;
    const members = groupSourceCreationIds(creation).filter(
      (id) => id !== creation.id,
    );
    out.push({
      id: creation.id,
      memberCount: members.length,
      createdAt: creation.createdAt || "",
    });
  }
  return out;
}

/**
 * Covers filed in another project's folder must not be reused — stamped
 * `meta.desktop.projectId` can be overwritten by a bad append, so folder
 * membership is the ownership authority for recovery.
 */
async function cabinetIdsOwnedByOtherProjects(
  projectId: string,
): Promise<Set<string>> {
  const want = projectId.trim();
  const foreign = new Set<string>();
  if (!want) return foreign;
  try {
    const folders = await listFolders();
    for (const folder of folders) {
      if (folder.kind !== "project") continue;
      const owner = folder.projectId?.trim() || "";
      if (!owner || owner === want) continue;
      for (const id of folder.memberIds) {
        const cid = String(id).trim();
        if (cid) foreign.add(cid);
      }
    }
  } catch {
    /* listing failed — skip folder filter rather than block ensure/file */
  }
  return foreign;
}

/**
 * Resolve the single Images/Videos cabinet for a project.
 * Prefers a live stored id; otherwise recovers from the local catalog.
 * Returns null only when no cabinet exists yet (safe to create the first one).
 */
export async function resolveProjectCabinetId(opts: {
  kind: ProjectGroupKind;
  projectId: string;
  projectTitle: string;
  storedGroupId: string | null;
  onProgress?: (note: string) => void;
  /** Optional preloaded catalog (avoids a second list during dedupe). */
  catalog?: Creation[];
}): Promise<string | null> {
  const label = opts.kind === "images" ? "Images" : "Videos";
  const role = roleForProjectGroupKind(opts.kind);
  const stored = opts.storedGroupId?.trim() || "";
  const foreignOwned = await cabinetIdsOwnedByOtherProjects(opts.projectId);

  // Prefer a cabinet already in this project's folder so we never create a
  // second Images/Videos cover while an older one is still filed.
  try {
    const folder = await getProjectFolder(opts.projectId);
    const rows = await getCreations(folder.memberIds.map(String));
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    const folderCandidates: CabinetCandidate[] = [];
    for (const raw of folder.memberIds) {
      const id = String(raw).trim();
      if (!id || foreignOwned.has(id)) continue;
      const creation = byId[id];
      if (
        !isSameProjectCabinetRole(creation, {
          role,
          projectId: opts.projectId,
          projectTitle: opts.projectTitle,
        })
      ) {
        continue;
      }
      const members = creation
        ? groupSourceCreationIds(creation).filter((mid) => mid !== id)
        : [];
      folderCandidates.push({
        id,
        memberCount: members.length,
        createdAt: creation?.createdAt || "",
      });
    }
    if (folderCandidates.length > 0) {
      const keeper =
        (stored && folderCandidates.some((c) => c.id === stored)
          ? stored
          : null) ?? pickCabinetKeeper(folderCandidates, stored || null);
      if (keeper) {
        opts.onProgress?.(
          `${label}: using folder cabinet ${keeper} (${folderCandidates.length} filed).`,
        );
        return keeper;
      }
    }
  } catch {
    /* folder lookup failed — fall through to stored / catalog */
  }

  if (stored) {
    if (foreignOwned.has(stored)) {
      opts.onProgress?.(
        `${label}: stored group ${stored} belongs to another project folder — will create a new cabinet.`,
      );
    } else {
      try {
        const row = await getRemoteCreation(stored);
        opts.onProgress?.(`${label}: verified ${stored} still on Parascene.`);
        return String(row.id);
      } catch {
        opts.onProgress?.(
          `${label}: stored group ${stored} missing — recovering from catalog…`,
        );
      }
    }
  }

  let catalog = opts.catalog;
  if (!catalog) {
    try {
      catalog = await listCreations();
    } catch {
      catalog = [];
    }
  }
  const candidates = findCabinetCandidatesInCatalog(catalog, {
    role,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  }).filter((c) => !foreignOwned.has(c.id));
  const recovered = pickCabinetKeeper(candidates, stored || null);
  if (recovered) {
    opts.onProgress?.(
      `${label}: recovered existing cabinet ${recovered} from catalog.`,
    );
    return recovered;
  }
  opts.onProgress?.(`${label}: no existing cabinet — will create.`);
  return null;
}

/** One Images or Videos cover in the project folder; unfile and ungroup extras. */
async function keepSingleProjectCabinetCover(opts: {
  kind: ProjectGroupKind;
  projectId: string;
  projectTitle: string;
  keeperId: string;
  extraOrphanIds?: readonly string[];
}): Promise<string[]> {
  const folder = await getProjectFolder(opts.projectId);
  const rows = await getCreations(folder.memberIds.map(String));
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const orphans = [
    ...siblingProjectCabinetCoverIds({
      keeperId: opts.keeperId,
      kind: opts.kind,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
      folderMemberIds: folder.memberIds.map(String),
      creationsById: byId,
    }),
    ...(opts.extraOrphanIds ?? []).map((id) => id.trim()).filter(Boolean),
  ].filter((id, index, all) => id !== opts.keeperId && all.indexOf(id) === index);

  if (orphans.length > 0) {
    try {
      await removeProjectAssetsChecked(opts.projectId, orphans);
    } catch {
      /* folder unfile is best-effort; ungroup still retires the extra cover */
    }
    const keeperMembers = cabinetMemberIdSet(
      byId[opts.keeperId] ?? (await getCreations([opts.keeperId]))[0],
      opts.keeperId,
    );
    for (const orphanId of orphans) {
      await ungroupAndMergeOrphan({
        orphanId,
        keeperId: opts.keeperId,
        kind: opts.kind,
        projectId: opts.projectId,
        projectTitle: opts.projectTitle,
        keeperMemberIds: keeperMembers,
        messages: [],
        onProgress: () => {},
      });
    }
  }

  await addProjectAssets(opts.projectId, [opts.keeperId]);
  return orphans;
}

/**
 * After a create completes, file into the matching project group when possible.
 * Still runs in the webview (single group call) — can move to `group_creations` later.
 */
export async function fileCreationIntoProjectGroup(opts: {
  creationId: string;
  mediaType: "image" | "video";
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
}): Promise<{
  groupId: string | null;
  message: string;
  projectCreationIds: string[];
}> {
  const kind: ProjectGroupKind =
    opts.mediaType === "image" ? "images" : "videos";
  const stored =
    opts.mediaType === "image" ? opts.imagesGroupId : opts.videosGroupId;
  const existing = await resolveProjectCabinetId({
    kind,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    storedGroupId: stored,
  });
  const groupId = await groupMembers({
    kind,
    existingGroupId: existing,
    memberIds: [opts.creationId],
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  });
  await keepSingleProjectCabinetCover({
    kind,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    keeperId: groupId,
    extraOrphanIds: existing && existing !== groupId ? [existing] : [],
  });
  await collapseCabinetMembersFromProjectFolder({
    projectId: opts.projectId,
    imagesGroupId: kind === "images" ? groupId : opts.imagesGroupId,
    videosGroupId: kind === "videos" ? groupId : opts.videosGroupId,
  });
  return {
    groupId,
    message: existing
      ? `Filed ${opts.creationId} into group ${groupId}.`
      : `Created ${kind === "images" ? "Images" : "Videos"} group ${groupId} from ${opts.creationId}.`,
    projectCreationIds: [groupId],
  };
}

/** Append loose assets to an existing project Images/Videos cabinet. */
export async function addMembersToProjectGroup(opts: {
  projectId: string;
  projectTitle: string;
  kind: ProjectGroupKind;
  groupId: string;
  memberIds: string[];
  imagesGroupId: string | null;
  videosGroupId: string | null;
  onProgress?: (note: string) => void;
}): Promise<{
  groupId: string;
  message: string;
  projectCreationIds: string[];
  addedMemberIds: string[];
}> {
  const memberIds = [
    ...new Set(opts.memberIds.map((id) => id.trim()).filter(Boolean)),
  ];
  if (memberIds.length === 0) {
    throw new Error("Choose at least one asset to add to the group.");
  }
  const onProgress = opts.onProgress ?? (() => {});
  const existing = await resolveProjectCabinetId({
    kind: opts.kind,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    storedGroupId: opts.groupId,
  });
  if (!existing) {
    throw new Error("Project group cover is missing — repair cabinets first.");
  }
  onProgress(
    `Adding ${memberIds.length} file(s) to the ${
      opts.kind === "images" ? "Images" : "Videos"
    } group…`,
  );
  const groupId = await groupMembers({
    kind: opts.kind,
    existingGroupId: existing,
    memberIds,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  });
  onProgress("Updating project folder…");
  await keepSingleProjectCabinetCover({
    kind: opts.kind,
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    keeperId: groupId,
    extraOrphanIds: existing && existing !== groupId ? [existing] : [],
  });
  await collapseCabinetMembersFromProjectFolder({
    projectId: opts.projectId,
    imagesGroupId: opts.kind === "images" ? groupId : opts.imagesGroupId,
    videosGroupId: opts.kind === "videos" ? groupId : opts.videosGroupId,
    onProgress,
  });
  return {
    groupId,
    addedMemberIds: memberIds,
    message: `Added ${memberIds.length} file(s) to ${opts.kind} group ${groupId}.`,
    projectCreationIds: [groupId],
  };
}

export type RepairCabinetFolderResult = {
  messages: string[];
  groupedIds: string[];
  collapsedIds: string[];
  mergedOrphanIds: string[];
  imagesGroupId: string | null;
  videosGroupId: string | null;
};

/**
 * Ensure project-folder videos/images that belong with the desktop cabinets are
 * actually members of those groups. Library folder view then shows the cover
 * only (members browse inside the group).
 */
export async function repairProjectCabinetFolderMembership(opts: {
  projectId: string;
  projectTitle: string;
  imagesGroupId: string | null;
  videosGroupId: string | null;
  onProgress?: (note: string) => void;
}): Promise<RepairCabinetFolderResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const messages: string[] = [];
  const groupedIds: string[] = [];

  let folderMemberIds: string[] = [];
  try {
    const folder = await getProjectFolder(opts.projectId);
    folderMemberIds = folder.memberIds.map(String);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    messages.push(`No project folder yet: ${message}`);
    return {
      messages,
      groupedIds,
      collapsedIds: [],
      mergedOrphanIds: [],
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
    };
  }

  if (folderMemberIds.length === 0) {
    messages.push("Project folder is empty.");
    return {
      messages,
      groupedIds,
      collapsedIds: [],
      mergedOrphanIds: [],
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
    };
  }

  onProgress(`Loading ${folderMemberIds.length} project-folder file(s)…`);
  const rows = await getCreations(folderMemberIds);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const imagesGroupId = await resolveProjectCabinetId({
    kind: "images",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    storedGroupId: opts.imagesGroupId,
  });
  const videosGroupId = await resolveProjectCabinetId({
    kind: "videos",
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
    storedGroupId: opts.videosGroupId,
  });

  const repairSide = async (
    kind: ProjectGroupKind,
    coverId: string | null,
  ): Promise<string | null> => {
    if (!coverId) {
      messages.push(`No ${kind} cabinet cover on this project.`);
      return null;
    }
    const cover = byId.get(coverId) ?? (await getCreations([coverId]))[0];
    if (!cover) {
      messages.push(`${kind} cover ${coverId} is missing from the catalog.`);
      return coverId;
    }
    const already = new Set(
      groupSourceCreationIds(cover).filter((id) => id && id !== coverId),
    );
    const media = kind === "images" ? "image" : "video";
    const candidates = folderMemberIds.filter((id) => {
      if (id === coverId || id === imagesGroupId || id === videosGroupId) {
        return false;
      }
      if (already.has(id)) return false;
      const row = byId.get(id);
      if (!row) return false;
      const type = String(row.mediaType ?? "").toLowerCase();
      return type === media;
    });
    if (candidates.length === 0) {
      messages.push(
        `${kind === "images" ? "Images" : "Videos"} cabinet already includes every matching folder file.`,
      );
      return coverId;
    }
    onProgress(
      `Filing ${candidates.length} ${media} file(s) into the ${kind} cabinet…`,
    );
    const groupId = await groupMembers({
      kind,
      existingGroupId: coverId,
      memberIds: candidates,
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
    });
    groupedIds.push(...candidates);
    messages.push(
      `Added ${candidates.length} ${media} file(s) to ${kind} cabinet ${groupId}.`,
    );
    // Keep the cover filed; members are collapsed out of folder_items next.
    await addProjectAssets(opts.projectId, [groupId]);
    return groupId;
  };

  const nextImages = await repairSide("images", imagesGroupId);
  const nextVideos = await repairSide("videos", videosGroupId);

  onProgress("Collapsing cabinet members out of the project folder…");
  const collapsed = await collapseCabinetMembersFromProjectFolder({
    projectId: opts.projectId,
    imagesGroupId: nextImages,
    videosGroupId: nextVideos,
    onProgress,
  });
  messages.push(...collapsed.messages);

  onProgress("Looking for unstamped duplicate covers at Library root…");
  const catalog = await listCreations();
  const keepers: CabinetKeeperRef[] = [];
  if (nextImages) {
    keepers.push({
      coverId: nextImages,
      role: "project_images",
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
    });
  }
  if (nextVideos) {
    keepers.push({
      coverId: nextVideos,
      role: "project_videos",
      projectId: opts.projectId,
      projectTitle: opts.projectTitle,
    });
  }
  const unstamped = await mergeUnstampedCabinetDuplicates({
    catalog,
    keepers,
    messages,
    onProgress,
  });

  if (
    groupedIds.length === 0 &&
    collapsed.removedIds.length === 0 &&
    unstamped.mergedOrphanIds.length === 0
  ) {
    messages.push(
      "Nothing new to group, collapse, or dedupe. Open the Videos/Images cover in the project folder to browse members.",
    );
  }

  return {
    messages,
    groupedIds,
    collapsedIds: collapsed.removedIds,
    mergedOrphanIds: unstamped.mergedOrphanIds,
    imagesGroupId: nextImages,
    videosGroupId: nextVideos,
  };
}

export type CabinetKeeperRef = {
  coverId: string;
  role: DesktopProjectGroupRole;
  projectId: string | null;
  projectTitle: string | null;
};

export type UnstampedCabinetDuplicate = {
  orphanId: string;
  keeperId: string;
  role: DesktopProjectGroupRole;
  projectId: string | null;
  projectTitle: string | null;
};

function cabinetMemberIdSet(
  creation: Creation | undefined,
  coverId: string,
): Set<string> {
  if (!creation) return new Set();
  return new Set(
    groupSourceCreationIds(creation).filter((id) => id && id !== coverId),
  );
}

function memberSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Unstamped regroup covers (filename `group/…`, no desktop meta/party name)
 * whose members exactly match a project Images/Videos cabinet. Those sit at
 * Library root because they were never filed; Dedupe/Repair should merge them
 * into the keeper instead of leaving a second cover.
 */
export function findUnstampedCabinetDuplicates(
  catalog: readonly Creation[],
  keepers: readonly CabinetKeeperRef[],
): UnstampedCabinetDuplicate[] {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const keeperIds = new Set(keepers.map((keeper) => keeper.coverId));
  const resolved = keepers
    .map((keeper) => ({
      ...keeper,
      members: cabinetMemberIdSet(byId.get(keeper.coverId), keeper.coverId),
    }))
    .filter((keeper) => keeper.members.size > 0);

  const matches: UnstampedCabinetDuplicate[] = [];
  const claimed = new Set<string>();
  for (const row of catalog) {
    if (keeperIds.has(row.id) || claimed.has(row.id)) continue;
    if (identifyDesktopCabinet(row)) continue;
    if (!isGroupCreation(row)) continue;
    const members = cabinetMemberIdSet(row, row.id);
    if (members.size === 0) continue;
    const keeper = resolved.find((candidate) =>
      memberSetsEqual(candidate.members, members),
    );
    if (!keeper) continue;
    claimed.add(row.id);
    matches.push({
      orphanId: row.id,
      keeperId: keeper.coverId,
      role: keeper.role,
      projectId: keeper.projectId,
      projectTitle: keeper.projectTitle,
    });
  }
  return matches;
}

function collectCabinetKeepers(opts: {
  catalog: readonly Creation[];
  buckets: readonly DedupeCabinetBucket[];
  preferredImagesGroupId?: string | null;
  preferredVideosGroupId?: string | null;
}): CabinetKeeperRef[] {
  const byId = new Map(opts.catalog.map((row) => [row.id, row]));
  const refs: CabinetKeeperRef[] = [];
  const seen = new Set<string>();
  const add = (ref: CabinetKeeperRef) => {
    const coverId = ref.coverId.trim();
    if (!coverId || seen.has(coverId) || !byId.has(coverId)) return;
    seen.add(coverId);
    refs.push({ ...ref, coverId });
  };

  for (const bucket of opts.buckets) {
    const preferred =
      bucket.role === "project_images"
        ? opts.preferredImagesGroupId
        : opts.preferredVideosGroupId;
    const candidates: CabinetCandidate[] = bucket.coverIds.map((id) => {
      const row = byId.get(id);
      const members = row
        ? groupSourceCreationIds(row).filter((mid) => mid !== id)
        : [];
      return {
        id,
        memberCount: members.length,
        createdAt: row?.createdAt || "",
      };
    });
    const keeper =
      pickCabinetKeeper(candidates, preferred) ?? bucket.coverIds[0];
    if (!keeper) continue;
    add({
      coverId: keeper,
      role: bucket.role,
      projectId: bucket.projectId,
      projectTitle: bucket.projectTitle,
    });
  }

  for (const project of loadStoredProjects()) {
    const title = project.title?.trim() || null;
    if (project.imagesGroupId) {
      add({
        coverId: project.imagesGroupId,
        role: "project_images",
        projectId: project.id,
        projectTitle: title,
      });
    }
    if (project.videosGroupId) {
      add({
        coverId: project.videosGroupId,
        role: "project_videos",
        projectId: project.id,
        projectTitle: title,
      });
    }
  }
  return refs;
}

async function ungroupAndMergeOrphan(opts: {
  orphanId: string;
  keeperId: string;
  kind: ProjectGroupKind;
  projectId: string;
  projectTitle: string;
  keeperMemberIds: ReadonlySet<string>;
  messages: string[];
  onProgress: (note: string) => void;
}): Promise<boolean> {
  opts.onProgress(`Ungrouping orphan ${opts.orphanId}…`);
  let restored: string[] = [];
  try {
    const result = await ungroupCreationsViaService(opts.orphanId);
    restored = result.restoredCreationIds;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.messages.push(`Failed to ungroup ${opts.orphanId}: ${msg}`);
    return false;
  }
  try {
    await deleteLocal(opts.orphanId);
  } catch {
    /* already gone */
  }

  const members = restored.filter(
    (id) =>
      id &&
      id !== opts.orphanId &&
      id !== opts.keeperId &&
      !opts.keeperMemberIds.has(id),
  );
  if (members.length === 0) {
    opts.messages.push(
      `Removed duplicate cover ${opts.orphanId}; members already in ${opts.keeperId}.`,
    );
    return true;
  }
  opts.onProgress(
    `Appending ${members.length} member(s) from ${opts.orphanId} into ${opts.keeperId}…`,
  );
  try {
    await groupMembers({
      kind: opts.kind,
      existingGroupId: opts.keeperId,
      memberIds: members,
      projectId: opts.projectId || "unknown",
      projectTitle: opts.projectTitle,
    });
    opts.messages.push(
      `Merged ${members.length} member(s) from ${opts.orphanId} into ${opts.keeperId}.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.messages.push(`Failed merging ${opts.orphanId} → ${opts.keeperId}: ${msg}`);
  }
  return true;
}

async function mergeUnstampedCabinetDuplicates(opts: {
  catalog: readonly Creation[];
  keepers: readonly CabinetKeeperRef[];
  messages: string[];
  onProgress: (note: string) => void;
}): Promise<{ mergedOrphanIds: string[] }> {
  const duplicates = findUnstampedCabinetDuplicates(opts.catalog, opts.keepers);
  const mergedOrphanIds: string[] = [];
  if (duplicates.length === 0) {
    return { mergedOrphanIds };
  }
  const byId = new Map(opts.catalog.map((row) => [row.id, row]));
  opts.onProgress(
    `Merging ${duplicates.length} unstamped duplicate cover(s)…`,
  );
  for (const duplicate of duplicates) {
    const keeperMembers = cabinetMemberIdSet(
      byId.get(duplicate.keeperId),
      duplicate.keeperId,
    );
    const removed = await ungroupAndMergeOrphan({
      orphanId: duplicate.orphanId,
      keeperId: duplicate.keeperId,
      kind: projectGroupKindForRole(duplicate.role),
      projectId: duplicate.projectId?.trim() || "",
      projectTitle: duplicate.projectTitle?.trim() || "Project",
      keeperMemberIds: keeperMembers,
      messages: opts.messages,
      onProgress: opts.onProgress,
    });
    if (removed) mergedOrphanIds.push(duplicate.orphanId);
  }
  return { mergedOrphanIds };
}

export type DedupeCabinetBucket = {
  projectKey: string;
  role: DesktopProjectGroupRole;
  projectId: string | null;
  projectTitle: string | null;
  coverIds: string[];
};

/** Group catalog desktop cabinets by (projectKey, role) for dedupe. */
export function bucketDesktopCabinets(
  creations: readonly Creation[],
): DedupeCabinetBucket[] {
  const identified: Array<{
    id: string;
    identity: NonNullable<ReturnType<typeof identifyDesktopCabinet>>;
  }> = [];
  for (const creation of creations) {
    const identity = identifyDesktopCabinet(creation);
    if (!identity) continue;
    identified.push({ id: creation.id, identity });
  }

  // Bucket by stamped projectId when present. Party-only covers stay in a
  // title: key — do not promote them onto a stamped id just because titles
  // match (default "Untitled project" cabinets from different projects collide).
  const map = new Map<string, DedupeCabinetBucket>();
  for (const { id, identity } of identified) {
    const projectId = identity.projectId?.trim() || null;
    const projectTitle = identity.projectTitle?.trim() || null;
    const projectKey = desktopCabinetProjectKey({
      projectId,
      projectTitle,
    });
    if (!projectKey) continue;
    const key = `${projectKey}::${identity.role}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        projectKey,
        role: identity.role,
        projectId,
        projectTitle,
        coverIds: [],
      };
      map.set(key, bucket);
    }
    if (!bucket.coverIds.includes(id)) {
      bucket.coverIds.push(id);
    }
    if (!bucket.projectId && projectId) {
      bucket.projectId = projectId;
    }
    if (!bucket.projectTitle && projectTitle) {
      bucket.projectTitle = projectTitle;
    }
  }
  return [...map.values()];
}

export type DedupeDesktopCabinetsResult = {
  messages: string[];
  /** Keeper cover ids after merge (one per bucket that had cabinets). */
  keeperIds: string[];
  /** Orphan covers that were merged away. */
  mergedOrphanIds: string[];
  /** Project store pointers updated to keepers. */
  projectUpdates: Array<{
    projectId: string;
    imagesGroupId?: string;
    videosGroupId?: string;
  }>;
};

/**
 * Merge duplicate Parascene Desktop Images/Videos cabinets in the Library.
 * Keeps one cover per (project, role); ungroups orphans and appends members
 * into the keeper. Updates local project store pointers when project ids match.
 */
export async function dedupeDesktopProjectCabinets(opts?: {
  /** Prefer these as keepers when present in a bucket. */
  preferredImagesGroupId?: string | null;
  preferredVideosGroupId?: string | null;
  onProgress?: (note: string) => void;
}): Promise<DedupeDesktopCabinetsResult> {
  const onProgress = opts?.onProgress ?? (() => {});
  const messages: string[] = [];
  const keeperIds: string[] = [];
  const mergedOrphanIds: string[] = [];
  const projectUpdates: DedupeDesktopCabinetsResult["projectUpdates"] = [];

  onProgress("Scanning Library for desktop cabinets…");
  const catalog = await listCreations();
  const buckets = bucketDesktopCabinets(catalog);
  const duplicateBuckets = buckets.filter((b) => b.coverIds.length > 1);
  onProgress(
    `Found ${buckets.length} cabinet bucket(s); ${duplicateBuckets.length} with duplicates.`,
  );

  const byId = new Map(catalog.map((c) => [c.id, c]));

  if (duplicateBuckets.length === 0) {
    applyCabinetPointersFromBuckets(buckets, projectUpdates, messages);
  } else {
    for (const bucket of duplicateBuckets) {
      const kind = projectGroupKindForRole(bucket.role);
      const preferred =
        bucket.role === "project_images"
          ? opts?.preferredImagesGroupId
          : opts?.preferredVideosGroupId;
      const candidates: CabinetCandidate[] = bucket.coverIds.map((id) => {
        const row = byId.get(id);
        const members = row
          ? groupSourceCreationIds(row).filter((mid) => mid !== id)
          : [];
        return {
          id,
          memberCount: members.length,
          createdAt: row?.createdAt || "",
        };
      });
      const keeper = pickCabinetKeeper(candidates, preferred);
      if (!keeper) continue;

      const orphans = bucket.coverIds.filter((id) => id !== keeper);
      const projectTitle =
        bucket.projectTitle?.trim() ||
        deriveTitleFromParty(byId.get(keeper)?.title, bucket.role) ||
        "Project";
      const projectId = bucket.projectId?.trim() || "";
      const keeperMemberIds = cabinetMemberIdSet(byId.get(keeper), keeper);

      onProgress(
        `Merging ${orphans.length} orphan ${kind} cover(s) into ${keeper}…`,
      );

      for (const orphan of orphans) {
        const removed = await ungroupAndMergeOrphan({
          orphanId: orphan,
          keeperId: keeper,
          kind,
          projectId,
          projectTitle,
          keeperMemberIds,
          messages,
          onProgress,
        });
        if (removed) mergedOrphanIds.push(orphan);
      }

      keeperIds.push(keeper);
      if (projectId) {
        const update: DedupeDesktopCabinetsResult["projectUpdates"][number] = {
          projectId,
        };
        if (kind === "images") update.imagesGroupId = keeper;
        else update.videosGroupId = keeper;
        projectUpdates.push(update);
      }
    }

    const singles = buckets.filter((b) => b.coverIds.length === 1);
    applyCabinetPointersFromBuckets(singles, projectUpdates, messages);
  }

  const keepers = collectCabinetKeepers({
    catalog,
    buckets,
    preferredImagesGroupId: opts?.preferredImagesGroupId,
    preferredVideosGroupId: opts?.preferredVideosGroupId,
  });
  const unstamped = await mergeUnstampedCabinetDuplicates({
    catalog,
    keepers,
    messages,
    onProgress,
  });
  mergedOrphanIds.push(...unstamped.mergedOrphanIds);
  if (keeperIds.length === 0) {
    keeperIds.push(...keepers.map((keeper) => keeper.coverId));
  } else {
    for (const keeper of keepers) {
      if (!keeperIds.includes(keeper.coverId)) keeperIds.push(keeper.coverId);
    }
  }

  if (duplicateBuckets.length === 0 && unstamped.mergedOrphanIds.length === 0) {
    messages.push("No duplicate desktop cabinets found.");
  }

  await persistProjectCabinetUpdates(projectUpdates, messages);
  onProgress(
    `Dedupe finished: ${mergedOrphanIds.length} orphan(s) merged, ${keeperIds.length} keeper(s).`,
  );
  return { messages, keeperIds, mergedOrphanIds, projectUpdates };
}

function deriveTitleFromParty(
  title: string | null | undefined,
  role: DesktopProjectGroupRole,
): string | null {
  const suffix = role === "project_images" ? " · Images" : " · Videos";
  const prefix = "Parascene Desktop · ";
  const raw = String(title ?? "").trim();
  if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) return null;
  return raw.slice(prefix.length, raw.length - suffix.length).trim() || null;
}

function applyCabinetPointersFromBuckets(
  buckets: readonly DedupeCabinetBucket[],
  projectUpdates: DedupeDesktopCabinetsResult["projectUpdates"],
  messages: string[],
): void {
  for (const bucket of buckets) {
    const coverId = bucket.coverIds[0];
    const projectId = bucket.projectId?.trim();
    if (!coverId || !projectId) continue;
    const existing = projectUpdates.find((u) => u.projectId === projectId);
    const update = existing ?? { projectId };
    if (bucket.role === "project_images") update.imagesGroupId = coverId;
    else update.videosGroupId = coverId;
    if (!existing) projectUpdates.push(update);
    messages.push(`Point ${projectId} ${bucket.role} → ${coverId}.`);
  }
}

async function persistProjectCabinetUpdates(
  updates: DedupeDesktopCabinetsResult["projectUpdates"],
  messages: string[],
): Promise<void> {
  if (updates.length === 0) return;
  const byProject = new Map<
    string,
    DedupeDesktopCabinetsResult["projectUpdates"][number]
  >();
  for (const u of updates) {
    const prev = byProject.get(u.projectId) ?? { projectId: u.projectId };
    byProject.set(u.projectId, {
      projectId: u.projectId,
      imagesGroupId: u.imagesGroupId ?? prev.imagesGroupId,
      videosGroupId: u.videosGroupId ?? prev.videosGroupId,
    });
  }
  await mutateStoredProjectsWithNativeMutation(
    async () => {
      const memberIdsByProject = new Map<string, string[]>();
      for (const patch of byProject.values()) {
        const ids = [patch.imagesGroupId, patch.videosGroupId].filter(
          (id): id is string => Boolean(id?.trim()),
        );
        if (ids.length === 0) continue;
        const result = await addProjectAssets(patch.projectId, ids);
        memberIdsByProject.set(patch.projectId, result.folder.memberIds);
      }
      return memberIdsByProject;
    },
    (projects, memberIdsByProject) =>
      projects.map((project) => {
        const patch = byProject.get(project.id);
        if (!patch) return project;
        const members = memberIdsByProject.get(project.id);
        const withMembers = members
          ? replaceStoredProjectAssets(project, members)
          : project;
        return setStoredProjectGroupIds(withMembers, {
          ...(patch.imagesGroupId !== undefined
            ? { imagesGroupId: patch.imagesGroupId }
            : {}),
          ...(patch.videosGroupId !== undefined
            ? { videosGroupId: patch.videosGroupId }
            : {}),
        });
      }),
  );
  messages.push(`Updated group ids on ${byProject.size} project(s).`);
}

async function loadExistingMemberIds(groupId: string): Promise<string[]> {
  const fromApi: string[] = [];
  try {
    fromApi.push(...memberIdsFromRemoteGroup(await getRemoteCreation(groupId)));
  } catch {
    // Detail endpoint may 404 mid-race; local catalog is the fallback.
  }
  let fromLocal: string[] = [];
  try {
    const rows = await getCreations([groupId]);
    const cover = rows[0];
    if (cover) fromLocal = groupSourceCreationIds(cover);
  } catch {
    // Catalog miss — API list (if any) is all we have.
  }
  return [...new Set([...fromApi, ...fromLocal])];
}

/** Stamp membership onto a (possibly sparse) detail row for local catalog ingest. */
export function withGroupMembership(
  row: RemoteCreateImage,
  memberIds: readonly string[],
  opts: {
    kind: ProjectGroupKind;
    projectId: string;
    projectTitle: string;
  },
): RemoteCreateImage {
  const role = roleForProjectGroupKind(opts.kind);
  const prevMeta =
    row.meta && typeof row.meta === "object" && !Array.isArray(row.meta)
      ? { ...row.meta }
      : {};
  const prevGroup =
    prevMeta.group &&
    typeof prevMeta.group === "object" &&
    !Array.isArray(prevMeta.group)
      ? { ...(prevMeta.group as Record<string, unknown>) }
      : {};
  const sourceIds = memberIds.map((id) => {
    const n = Number(id);
    return Number.isFinite(n) ? n : id;
  });
  return {
    ...row,
    title: desktopProjectGroupPartyName(opts.projectTitle, role),
    meta: {
      ...prevMeta,
      ...desktopProjectGroupMeta({
        role,
        projectId: opts.projectId,
      }),
      group: {
        ...prevGroup,
        kind: "group_creations",
        source_creation_ids: sourceIds,
      },
    },
  };
}

async function groupMembers(opts: {
  kind: ProjectGroupKind;
  existingGroupId: string | null;
  memberIds: string[];
  projectId: string;
  projectTitle: string;
}): Promise<string> {
  // Already-filed members are hidden as standalone rows — resending them
  // returns "Cannot group deleted creations".
  const existingMemberIds = opts.existingGroupId
    ? await loadExistingMemberIds(opts.existingGroupId)
    : [];
  const toAppend = newIdsToAppendToGroup(
    opts.existingGroupId,
    existingMemberIds,
    opts.memberIds,
  );
  if (toAppend.length === 0 && opts.existingGroupId) {
    return opts.existingGroupId;
  }

  const ids = idsForGroupApiCall(opts.existingGroupId, toAppend);
  const expectedMembers = expectedMembersAfterAppend(
    existingMemberIds,
    opts.memberIds,
  );
  const role = roleForProjectGroupKind(opts.kind);
  const grouped = await groupAppendCreations({
    ids,
    partyName: desktopProjectGroupPartyName(opts.projectTitle, role),
    meta: desktopProjectGroupMeta({
      role,
      projectId: opts.projectId,
    }),
  });
  const groupId = String(grouped.id);

  // Re-fetch + ingest so Editor Assets expands the updated member list.
  // GET /api/create/images/:id often omits meta.group (same gap as fit thumbs).
  const fresh = await getRemoteCreation(groupId);
  const liveMembers = memberIdsFromRemoteGroup(fresh);
  if (liveMembers.length > 0) {
    const missing = opts.memberIds.filter((id) => !liveMembers.includes(id));
    if (missing.length > 0) {
      throw new Error(
        `Grouped as ${groupId} but Parascene still missing member(s): ${missing.join(", ")} (have ${liveMembers.join(", ") || "none"})`,
      );
    }
    await ingestRemoteCreation(
      withGroupMembership(fresh, liveMembers, {
        kind: opts.kind,
        projectId: opts.projectId,
        projectTitle: opts.projectTitle,
      }),
    );
  } else {
    await ingestRemoteCreation(
      withGroupMembership(fresh, expectedMembers, {
        kind: opts.kind,
        projectId: opts.projectId,
        projectTitle: opts.projectTitle,
      }),
    );
  }
  // Cover artwork URL often changes to the newest member — block until new
  // bytes land (upsert clears stale local media when remote URLs change).
  // ensureLocal only enqueues; these invokes wait so Library gets a new path /
  // updatedAt before Lab reports "Filed".
  await downloadIds([groupId]);
  await downloadThumbs([groupId]);
  return groupId;
}
