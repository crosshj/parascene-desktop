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
