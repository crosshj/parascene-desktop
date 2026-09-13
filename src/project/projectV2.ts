/** Desktop view of a Parascene project-v2 container. */

export const PROJECT_V2_TYPE = "project";
export const GROUP_V2_KIND = "group_v2";
export const PROJECT_V2_FOLDER_PREFIX = "project-v2-";

const LOCAL_POINTER_RE = /^local:\/\/([^/]+)\/(.+)$/;

export type ProjectV2Pointer =
  | { kind: "creation"; creationId: string }
  | { kind: "local"; uri: string; libraryId: string; assetId: string };

export type ProjectV2View = {
  mediaType: "image" | "video" | "audio";
  title?: string;
  url?: string;
  thumbnailUrl?: string;
  filename?: string;
  filePath?: string;
  width?: number;
  height?: number;
  status?: string;
};

export type ProjectV2Item = {
  id: string;
  cover: boolean;
  view: ProjectV2View;
  pointer: ProjectV2Pointer;
};

export function isStoredProjectV2(project: {
  containerVersion?: string | null;
  parasceneProjectId?: string | null;
}): boolean {
  return (
    project.containerVersion === "v2" &&
    Boolean(project.parasceneProjectId?.trim())
  );
}

export function parseLocalUri(uri: string | null | undefined): {
  uri: string;
  libraryId: string;
  assetId: string;
} | null {
  const match = LOCAL_POINTER_RE.exec(String(uri ?? "").trim());
  if (!match) return null;
  const libraryId = match[1].trim();
  const assetId = match[2].trim();
  if (!libraryId || !assetId) return null;
  return { uri: `local://${libraryId}/${assetId}`, libraryId, assetId };
}

export function localUri(libraryId: string, assetId: string): string | null {
  const lib = libraryId.trim();
  const id = assetId.trim();
  if (!lib || !id) return null;
  return `local://${lib}/${id}`;
}

export function isThisMachineLocalPointer(
  pointer: ProjectV2Pointer,
  libraryId: string,
): boolean {
  return pointer.kind === "local" && pointer.libraryId === libraryId.trim();
}

function mediaTypeOf(value: unknown): ProjectV2View["mediaType"] {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "video" || raw === "audio") return raw;
  return "image";
}

export function normalizePointer(raw: unknown): ProjectV2Pointer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (String(row.kind ?? "").trim() === "local") {
    const parsed = parseLocalUri(String(row.uri ?? row.local ?? ""));
    if (!parsed) return null;
    return {
      kind: "local",
      uri: parsed.uri,
      libraryId: parsed.libraryId,
      assetId: parsed.assetId,
    };
  }
  const creationId = String(row.creation_id ?? row.creationId ?? row.id ?? "").trim();
  if (!creationId || !/^\d+$/.test(creationId)) return null;
  return { kind: "creation", creationId };
}

export function normalizeProjectV2Item(raw: unknown): ProjectV2Item | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const pointer = normalizePointer(row.pointer);
  if (!pointer) return null;
  const viewRaw =
    row.view && typeof row.view === "object"
      ? (row.view as Record<string, unknown>)
      : {};
  const id =
    typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : pointer.kind === "local"
        ? pointer.uri
        : `creation:${pointer.creationId}`;
  const view: ProjectV2View = { mediaType: mediaTypeOf(viewRaw.mediaType ?? viewRaw.media_type) };
  if (typeof viewRaw.title === "string" && viewRaw.title.trim()) {
    view.title = viewRaw.title.trim();
  }
  if (typeof viewRaw.url === "string" && viewRaw.url.trim()) view.url = viewRaw.url.trim();
  const thumb = viewRaw.thumbnailUrl ?? viewRaw.thumbnail_url;
  if (typeof thumb === "string" && thumb.trim()) view.thumbnailUrl = thumb.trim();
  if (typeof viewRaw.filename === "string" && viewRaw.filename.trim()) {
    view.filename = viewRaw.filename.trim();
  }
  const filePath = viewRaw.filePath ?? viewRaw.file_path;
  if (typeof filePath === "string" && filePath.trim()) view.filePath = filePath.trim();
  if (typeof viewRaw.status === "string" && viewRaw.status.trim()) {
    view.status = viewRaw.status.trim();
  }
  const width = Number(viewRaw.width);
  const height = Number(viewRaw.height);
  if (Number.isFinite(width) && width > 0) view.width = Math.round(width);
  if (Number.isFinite(height) && height > 0) view.height = Math.round(height);
  return { id, cover: row.cover === true, view, pointer };
}

export function projectV2ItemsFromUnknown(value: unknown): ProjectV2Item[] {
  if (!Array.isArray(value)) return [];
  const out: ProjectV2Item[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = normalizeProjectV2Item(raw);
    if (!item) continue;
    const key =
      item.pointer.kind === "local"
        ? item.pointer.uri
        : `creation:${item.pointer.creationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function parseProjectV2Remote(raw: unknown): {
  id: string;
  title: string;
  items: ProjectV2Item[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = String(row.id ?? "").trim();
  if (!id) return null;
  const meta =
    row.meta && typeof row.meta === "object"
      ? (row.meta as Record<string, unknown>)
      : {};
  const group =
    meta.group && typeof meta.group === "object"
      ? (meta.group as Record<string, unknown>)
      : {};
  const type = String(meta.type ?? meta.creation_type ?? row.type ?? "").trim();
  if (type !== PROJECT_V2_TYPE) return null;
  const title =
    (typeof row.title === "string" && row.title.trim()) ||
    (typeof meta.title === "string" && meta.title.trim()) ||
    "";
  const items = projectV2ItemsFromUnknown(row.items ?? group.items);
  return { id, title, items };
}

export function isProjectV2Creation(creation: {
  filename?: string | null;
  remoteJson?: string | null;
}): boolean {
  const filename = creation.filename?.trim().toLowerCase() ?? "";
  if (filename.startsWith("project/")) return true;
  if (!creation.remoteJson) return false;
  try {
    return parseProjectV2Remote(JSON.parse(creation.remoteJson)) != null;
  } catch {
    return false;
  }
}

export function projectV2ItemsFromCreation(creation: {
  remoteJson?: string | null;
}): ProjectV2Item[] {
  if (!creation.remoteJson) return [];
  try {
    return parseProjectV2Remote(JSON.parse(creation.remoteJson))?.items ?? [];
  } catch {
    return [];
  }
}

export function collectProjectV2MemberIds(
  creations: ReadonlyArray<{
    id: string;
    filename?: string | null;
    remoteJson?: string | null;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const creation of creations) {
    if (!isProjectV2Creation(creation)) continue;
    for (const item of projectV2ItemsFromCreation(creation)) {
      if (item.pointer.kind === "creation" && item.pointer.creationId !== creation.id) {
        out.add(item.pointer.creationId);
      }
    }
  }
  return out;
}

/** Cover is a flag on one row. Fall back to the first list row, not newest. */
export function coverAssetIdFromV2Items(
  items: readonly ProjectV2Item[],
  libraryId: string,
  opts?: { flaggedOnly?: boolean },
): string | null {
  const cover = opts?.flaggedOnly
    ? items.find((item) => item.cover) ?? null
    : items.find((item) => item.cover) ?? items[0] ?? null;
  if (!cover) return null;
  if (cover.pointer.kind === "creation") return cover.pointer.creationId;
  if (isThisMachineLocalPointer(cover.pointer, libraryId)) {
    return cover.pointer.assetId;
  }
  return null;
}

export function coverViewFromV2Items(items: readonly ProjectV2Item[]): ProjectV2View | null {
  const cover = items.find((item) => item.cover) ?? items[0] ?? null;
  return cover?.view ?? null;
}

export function assetIdsFromProjectV2Items(
  items: readonly ProjectV2Item[],
  libraryId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let id = "";
    if (item.pointer.kind === "creation") id = item.pointer.creationId;
    else if (isThisMachineLocalPointer(item.pointer, libraryId)) {
      id = item.pointer.assetId;
    } else {
      id = item.pointer.uri;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function v2FolderId(parasceneProjectId: string): string {
  return `${PROJECT_V2_FOLDER_PREFIX}${parasceneProjectId.trim()}`;
}

export function parasceneIdFromV2FolderId(folderId: string): string | null {
  const raw = folderId.trim();
  if (!raw.startsWith(PROJECT_V2_FOLDER_PREFIX)) return null;
  const id = raw.slice(PROJECT_V2_FOLDER_PREFIX.length).trim();
  return id || null;
}

export function isV2ProjectFolder(folder: {
  containerVersion?: string | null;
  id?: string;
}): boolean {
  return (
    folder.containerVersion === "v2" ||
    Boolean(folder.id && parasceneIdFromV2FolderId(folder.id))
  );
}

export function isParasceneCreationId(id: string): boolean {
  return /^\d+$/.test(id.trim());
}

export function omitProjectV2Creations<
  T extends { id: string; filename?: string | null; remoteJson?: string | null },
>(creations: readonly T[]): T[] {
  return creations.filter((creation) => !isProjectV2Creation(creation));
}
