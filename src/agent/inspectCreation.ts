import {
  groupSourceCreationIds,
  isGroupCreation,
} from "../library/creationFlags";
import { isLocalOnlyCreation } from "../library/creationFilters";
import type { Creation } from "../library/types";
import { desktopProjectGroupMetaFromCreation } from "../project/desktopProjectGroups";
import { memberIdsFromRemoteGroup } from "../lab/projectGroups";
import type { RemoteCreateImage } from "../sdk/parascene";

export type InspectedFolder = {
  id: string;
  title: string;
  kind: string;
  projectId: string | null;
};

export type InspectFolderInput = InspectedFolder & {
  memberIds: readonly string[];
};

export type InspectCabinetInput = {
  imagesGroupId: string | null;
  videosGroupId: string | null;
  imagesMemberIds: readonly string[];
  videosMemberIds: readonly string[];
};

export type InspectedLocalRow = {
  id: string;
  title: string;
  mediaType: string;
  localPath: string | null;
  localThumbPath: string | null;
  remoteUrl: string | null;
  downloadState: string;
  localOnly: boolean;
  origin: "local" | "parascene";
  groupKind: string | null;
  memberIds: string[];
  folderIds: string[];
  folders: InspectedFolder[];
  imagesGroupId: string | null;
  videosGroupId: string | null;
  cabinet: "images" | "videos" | "cover" | null;
  inProject: boolean;
};

export type InspectedRemoteRow = {
  id: string;
  title: string;
  mediaType: string;
  groupKind: string | null;
  memberIds: string[];
};

export type WwwCostumeMember = {
  id: string;
  mediaType: string;
  filePath: string | null;
};

export type WwwCostumeSnapshot = {
  id: string;
  title: string;
  published: boolean;
  mediaType: string;
  url: string | null;
  thumbnailUrl: string | null;
  filename: string;
  creationType: string;
  groupKind: string | null;
  badge: string | null;
  coverSourceId: string | null;
  members: WwwCostumeMember[];
  supported: Record<string, boolean> | null;
  rawItemsLeaked: boolean;
  costumeApplied: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function groupRecord(row: RemoteCreateImage): Record<string, unknown> | null {
  const meta = asRecord(row.meta);
  return asRecord(meta?.group) ?? asRecord(row.group);
}

function supportedFromGroup(
  group: Record<string, unknown> | null,
): Record<string, boolean> | null {
  const raw = asRecord(group?.supported);
  if (!raw) return null;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function membersFromSources(sources: unknown): WwwCostumeMember[] {
  if (!Array.isArray(sources)) return [];
  const out: WwwCostumeMember[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const rec = asRecord(source);
    const id = asId(rec?.id ?? source);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const meta = asRecord(rec?.meta);
    out.push({
      id,
      mediaType: String(meta?.media_type ?? rec?.media_type ?? ""),
      filePath: asNullableString(rec?.file_path ?? rec?.url),
    });
  }
  return out;
}

function membersFromRawItems(items: unknown): WwwCostumeMember[] {
  if (!Array.isArray(items)) return [];
  const out: WwwCostumeMember[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const rec = asRecord(item);
    const pointer = asRecord(rec?.pointer);
    if (!pointer) continue;
    const kind = String(pointer.kind ?? "").trim();
    if (kind && kind !== "creation") continue;
    const id = asId(pointer.creationId ?? pointer.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const view = asRecord(rec?.view) ?? {};
    out.push({
      id,
      mediaType: String(view.mediaType ?? view.media_type ?? ""),
      filePath: asNullableString(view.filePath ?? view.url ?? view.file_path),
    });
  }
  return out;
}

/** Website GET costume: old group shape, no raw `items[]`. */
export function inspectWwwCreation(row: RemoteCreateImage): WwwCostumeSnapshot {
  const meta = asRecord(row.meta);
  const group = groupRecord(row);
  const groupKind =
    typeof group?.kind === "string" && group.kind.trim()
      ? group.kind.trim()
      : null;
  const sourceCreations = group?.source_creations;
  const costumeApplied =
    groupKind === "group_creations" || Array.isArray(sourceCreations);
  const members = costumeApplied
    ? membersFromSources(sourceCreations)
    : membersFromRawItems(row.items ?? group?.items);
  return {
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    published: row.published === true,
    mediaType: String(row.media_type ?? ""),
    url: asNullableString(row.url),
    thumbnailUrl: asNullableString(row.thumbnail_url),
    filename: typeof row.filename === "string" ? row.filename : "",
    creationType: String(meta?.type ?? meta?.creation_type ?? "").trim(),
    groupKind,
    badge:
      typeof group?.badge === "string" && group.badge.trim()
        ? group.badge.trim()
        : null,
    coverSourceId: asId(group?.cover_source_id) || null,
    members,
    supported: supportedFromGroup(group),
    rawItemsLeaked:
      Array.isArray(row.items) || Array.isArray(group?.items),
    costumeApplied,
  };
}

export function groupFieldsFromRemoteJson(
  remoteJson: string | null | undefined,
  filename?: string | null,
): { groupKind: string | null; memberIds: string[] } {
  const row = { remoteJson: remoteJson ?? null, filename: filename ?? null };
  const meta = desktopProjectGroupMetaFromCreation(row);
  let groupKind: string | null = null;
  if (isGroupCreation(row)) {
    if (meta?.role === "project_images") groupKind = "images";
    else if (meta?.role === "project_videos") groupKind = "videos";
    else groupKind = "group";
  }
  return { groupKind, memberIds: groupSourceCreationIds(row) };
}

export function inspectCabinetRole(
  id: string,
  cabinets: InspectCabinetInput,
): "images" | "videos" | "cover" | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (
    trimmed === (cabinets.imagesGroupId ?? "").trim() ||
    trimmed === (cabinets.videosGroupId ?? "").trim()
  ) {
    return "cover";
  }
  if (cabinets.imagesMemberIds.some((memberId) => memberId.trim() === trimmed)) {
    return "images";
  }
  if (cabinets.videosMemberIds.some((memberId) => memberId.trim() === trimmed)) {
    return "videos";
  }
  return null;
}

export function inspectLocalRow(
  row: Creation,
  folders: readonly InspectFolderInput[],
  cabinets: InspectCabinetInput,
): InspectedLocalRow {
  const localOnly = isLocalOnlyCreation(row);
  const { groupKind, memberIds } = groupFieldsFromRemoteJson(
    row.remoteJson,
    row.filename,
  );
  const folderHits = folders.filter((folder) =>
    folder.memberIds.some((memberId) => memberId === row.id),
  );
  const cabinet = inspectCabinetRole(row.id, cabinets);
  const inProjectFolder = folderHits.some((folder) => folder.kind === "project");
  return {
    id: row.id,
    title: row.title,
    mediaType: String(row.mediaType ?? ""),
    localPath: row.localPath,
    localThumbPath: row.localThumbPath,
    remoteUrl: row.remoteUrl,
    downloadState: String(row.downloadState ?? ""),
    localOnly,
    origin: localOnly ? "local" : "parascene",
    groupKind,
    memberIds,
    folderIds: folderHits.map((folder) => folder.id),
    folders: folderHits.map(({ id, title, kind, projectId }) => ({
      id,
      title,
      kind,
      projectId,
    })),
    imagesGroupId: cabinets.imagesGroupId,
    videosGroupId: cabinets.videosGroupId,
    cabinet,
    inProject: inProjectFolder || cabinet != null,
  };
}

export function inspectRemoteRow(row: RemoteCreateImage): InspectedRemoteRow {
  const remoteJson = JSON.stringify(row);
  const fromJson = groupFieldsFromRemoteJson(remoteJson, row.filename);
  const memberIds =
    fromJson.memberIds.length > 0
      ? fromJson.memberIds
      : memberIdsFromRemoteGroup(row);
  let groupKind = fromJson.groupKind;
  if (!groupKind && memberIds.length > 0) groupKind = "group";
  return {
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    mediaType: String(row.media_type ?? ""),
    groupKind,
    memberIds,
  };
}

export function statusFromCloudError(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  const paren = message.match(/\((\d{3})\)/);
  if (paren) return Number(paren[1]);
  const bare = message.match(/\b(401|403|404|410|500)\b/);
  if (bare) return Number(bare[1]);
  if (/not found|does not exist|failed to fetch/i.test(message)) return 404;
  return 500;
}

export function isCloudMissingStatus(status: number): boolean {
  return status === 404 || status === 410;
}
