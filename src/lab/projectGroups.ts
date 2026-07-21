/**
 * Project Images / Videos group helpers.
 *
 * Ensure + cleanup run on the Rust generation job queue. Lab only enqueues,
 * watches job UUID status, and writes group ids into the project store.
 */

import { createAuthedSdk } from "../auth/session";
import {
  cancelJob,
  checkpointFromJob,
  cleanupResultFromJob,
  enqueueJob,
  ensureResultFromJob,
  getJob,
  jobProgressMessages,
  watchJob,
} from "../jobs/jobsClient";
import type { Job } from "../jobs/types";
import {
  deleteLocal,
  downloadIds,
  downloadThumbs,
  getCreations,
} from "../library/catalogClient";
import { groupSourceCreationIds } from "../library/creationFlags";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  isProjectAspectRatio,
  type ProjectAspectRatio,
} from "../project/aspectRatios";
import type { ParasceneSdk, RemoteCreateImage } from "../sdk/parascene";
import { absolutizeAssetUrl } from "../sdk/parascene";
import {
  desktopProjectGroupMeta,
  desktopProjectGroupPartyName,
  roleForProjectGroupKind,
} from "../project/desktopProjectGroups";
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
  const sdk = createAuthedSdk();
  const groupId = String(opts.groupId).trim();
  const toRemove = [
    ...new Set(
      opts.memberIds.map((id) => String(id).trim()).filter(Boolean),
    ),
  ].filter((id) => id !== groupId);
  if (!groupId || toRemove.length === 0) {
    throw new Error("Nothing to remove from group.");
  }

  const existingMembers = await loadExistingMemberIds(sdk, groupId);
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
  const { restoredCreationIds } = await sdk.ungroupCreations(groupId);
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
      await sdk.deleteCreation(id);
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
    const grouped = await sdk.groupCreations({
      ids: idsForGroupApiCall(null, remaining),
      partyName,
      meta: groupMeta,
    });
    finalGroupId = String(grouped.id);
    const fresh = await sdk.getCreation(finalGroupId);
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
  sdk: ParasceneSdk;
}): Promise<{ imageUrl: string; sourceId: string }> {
  const groupId = opts.imagesGroupId?.trim() || "";
  if (!groupId) {
    throw new Error("Images group not ready — run Project groups first.");
  }

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
    const live = await opts.sdk.getCreation(groupId);
    const liveMembers = memberIdsFromRemoteGroup(live);
    if (liveMembers.length > 0) memberIds = liveMembers;
    coverSourceId = coverSourceIdFromRemoteGroup(live) ?? coverSourceId;
    coverUrl = remoteStillUrlFromApiRow(live, opts.sdk.baseUrl) ?? coverUrl;
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
        const live = await opts.sdk.getCreation(id);
        const url = remoteStillUrlFromApiRow(live, opts.sdk.baseUrl);
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
    const existing = await getJob(opts.backendJobId);
    if (!existing) {
      opts.onProgress?.(
        `Backend job ${opts.backendJobId} missing — starting a fresh ensure.`,
      );
      job = await enqueueJob({
        kind: "ensure_project_groups",
        projectId: opts.projectId,
        label,
        payload,
      });
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
    job = await enqueueJob({
      kind: "ensure_project_groups",
      projectId: opts.projectId,
      label,
      payload,
    });
    opts.onProgress?.(`Queued ensure as job ${job.id}.`);
    opts.onCheckpoint?.({ backendJobId: job.id });
  }

  try {
    const finalJob = await watchJob(job.id, {
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
  const job = await enqueueJob({
    kind: "cleanup_project_groups",
    projectId: opts.projectId,
    label: "Cleanup project groups",
    payload: {
      imagesGroupId: opts.imagesGroupId,
      videosGroupId: opts.videosGroupId,
      pendingCreationId: opts.pendingCreationId ?? null,
      memberIds: opts.memberIds ?? [],
    },
  });
  opts.onJobId?.(job.id);
  opts.onProgress?.(`Queued cleanup as job ${job.id}.`);

  const finalJob = await watchJob(job.id, {
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
    await cancelJob(jobId);
  } catch {
    /* already gone */
  }
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
  const sdk = createAuthedSdk();
  const existing = await verifyLiveGroupId(
    sdk,
    stored,
    () => {},
    kind === "images" ? "Images" : "Videos",
  );
  const groupId = await groupMembers({
    sdk,
    kind,
    existingGroupId: existing,
    memberIds: [opts.creationId],
    projectId: opts.projectId,
    projectTitle: opts.projectTitle,
  });
  return {
    groupId,
    message: existing
      ? `Filed ${opts.creationId} into group ${groupId}.`
      : `Created ${kind === "images" ? "Images" : "Videos"} group ${groupId} from ${opts.creationId}.`,
    // Cover for Parascene filing + the member so Editor/timeline can select it.
    projectCreationIds: [groupId, opts.creationId],
  };
}

async function verifyLiveGroupId(
  sdk: ParasceneSdk,
  id: string | null,
  progress: (note: string) => void,
  label: string,
): Promise<string | null> {
  if (!id) return null;
  try {
    const row = await sdk.getCreation(id);
    progress(`${label}: verified ${id} still on Parascene.`);
    return String(row.id);
  } catch {
    progress(
      `${label}: stored group ${id} is missing (deleted?) — starting fresh.`,
    );
    return null;
  }
}

async function loadExistingMemberIds(
  sdk: ParasceneSdk,
  groupId: string,
): Promise<string[]> {
  const fromApi: string[] = [];
  try {
    fromApi.push(...memberIdsFromRemoteGroup(await sdk.getCreation(groupId)));
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
  sdk: ParasceneSdk;
  kind: ProjectGroupKind;
  existingGroupId: string | null;
  memberIds: string[];
  projectId: string;
  projectTitle: string;
}): Promise<string> {
  // For local stamp only — do not re-send these on the group POST.
  const existingMemberIds = opts.existingGroupId
    ? await loadExistingMemberIds(opts.sdk, opts.existingGroupId)
    : [];

  const ids = idsForGroupApiCall(opts.existingGroupId, opts.memberIds);
  const expectedMembers = expectedMembersAfterAppend(
    existingMemberIds,
    opts.memberIds,
  );
  const role = roleForProjectGroupKind(opts.kind);
  const grouped = await opts.sdk.groupCreations({
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
  const fresh = await opts.sdk.getCreation(groupId);
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
