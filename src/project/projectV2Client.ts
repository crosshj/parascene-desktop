import { invoke } from "@tauri-apps/api/core";
import type { CreationUpsert } from "../library/types";
import {
  coverViewFromV2Items,
  parseProjectV2Remote,
  type ProjectV2Item,
  type ProjectV2Pointer,
} from "./projectV2";

export type ProjectV2Remote = {
  id: string;
  title: string;
  items: ProjectV2Item[];
  raw: unknown;
};

function asRemote(value: unknown): ProjectV2Remote {
  const parsed = parseProjectV2Remote(value);
  if (!parsed) {
    throw new Error("Parascene did not return a project container.");
  }
  return { ...parsed, raw: value };
}

export function pointerPayload(pointer: ProjectV2Pointer): Record<string, unknown> {
  if (pointer.kind === "local") {
    return { kind: "local", uri: pointer.uri };
  }
  return { kind: "creation", creation_id: Number(pointer.creationId) };
}

export function ensureLibraryId(): Promise<string> {
  return invoke<string>("library_ensure_library_id");
}

/** Mint a project by creating a group v2 with type: project. */
export async function createProjectV2(opts: {
  title: string;
  items?: Array<{ pointer: ProjectV2Pointer; view?: Record<string, unknown>; cover?: boolean }>;
  ids?: string[];
}): Promise<ProjectV2Remote> {
  const raw = await invoke<unknown>("library_create_project_v2", {
    title: opts.title,
    items: (opts.items ?? []).map((item) => ({
      pointer: pointerPayload(item.pointer),
      view: item.view ?? {},
      cover: item.cover === true,
    })),
    ids: opts.ids ?? [],
  });
  return asRemote(raw);
}

export async function getProjectV2(id: string): Promise<ProjectV2Remote> {
  const raw = await invoke<unknown>("library_get_project_v2", { id });
  return asRemote(raw);
}

export async function patchProjectV2(
  id: string,
  body: {
    title?: string;
    add?: Array<Record<string, unknown> | string | number>;
    remove?: Array<Record<string, unknown> | string | number> | string | number;
    cover?: string | number;
  },
): Promise<ProjectV2Remote> {
  const raw = await invoke<unknown>("library_patch_project_v2", { id, body });
  return asRemote(raw);
}

export async function ingestProjectV2Snapshot(raw: unknown): Promise<void> {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!row?.id) return;
  const { applyManifest } = await import("../library/catalogClient");
  const parsed = parseProjectV2Remote(raw);
  const coverView = parsed ? coverViewFromV2Items(parsed.items) : null;
  const rowUrl = typeof row.url === "string" ? row.url.trim() : "";
  const rowThumb =
    typeof row.thumbnail_url === "string" ? row.thumbnail_url.trim() : "";
  const coverUrl = coverView?.url?.trim() || coverView?.filePath?.trim() || "";
  const coverThumb = coverView?.thumbnailUrl?.trim() || coverUrl;
  const upsert: CreationUpsert = {
    id: String(row.id),
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : `Project ${row.id}`,
    mediaType: "image",
    remoteUrl: rowUrl || coverUrl || null,
    thumbnailUrl: rowThumb || coverThumb || null,
    videoUrl: null,
    published: false,
    publishedAt: null,
    createdAt:
      typeof row.created_at === "string" && row.created_at
        ? row.created_at
        : new Date().toISOString(),
    downloadState: "remote",
    prompt: null,
    filename: typeof row.filename === "string" ? row.filename : `project/${row.id}`,
    description: typeof row.description === "string" ? row.description : null,
    color: null,
    status: typeof row.status === "string" ? row.status : "completed",
    width: typeof row.width === "number" ? row.width : null,
    height: typeof row.height === "number" ? row.height : null,
    aspectRatio: null,
    nsfw: false,
    isModeratedError: false,
    remoteJson: JSON.stringify(row),
  };
  await applyManifest([upsert]);
}
