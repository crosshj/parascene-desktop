/**
 * Desktop “cabinet” groups — Images/Videos filing for a project so Parascene’s
 * creations feed stays uncluttered. Distinct from creative image packs that
 * Editor expands into slideshow clips.
 *
 * Detection (prefer in order):
 * 1. Project store ids (`imagesGroupId` / `videosGroupId`)
 * 2. Stamped meta on the Parascene group row (see {@link DESKTOP_GROUP_META_KEY})
 *
 * Party names are human-facing on Parascene; meta is the machine signal.
 */

import { isGroupCreation } from "../library/creationFlags";
import type { Creation } from "../library/types";

export const DESKTOP_GROUP_META_KEY = "desktop";

export type DesktopProjectGroupRole = "project_images" | "project_videos";

export type DesktopProjectGroupMeta = {
  role: DesktopProjectGroupRole;
  /** Open project id when known (helps recovery / multi-project). */
  projectId?: string;
  /** Client marker — always "parascene-desktop". */
  client: "parascene-desktop";
};

export type ProjectCabinetIds = {
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
};

/** Meta blob to send on `POST /api/create/images/group` (and hope the API persists it). */
export function desktopProjectGroupMeta(opts: {
  role: DesktopProjectGroupRole;
  projectId?: string | null;
}): Record<string, unknown> {
  const desktop: DesktopProjectGroupMeta = {
    role: opts.role,
    client: "parascene-desktop",
  };
  const pid = opts.projectId?.trim();
  if (pid) desktop.projectId = pid;
  return { [DESKTOP_GROUP_META_KEY]: desktop };
}

/** Parascene-visible party name for cabinets. */
export function desktopProjectGroupPartyName(
  projectTitle: string,
  role: DesktopProjectGroupRole,
): string {
  const base = projectTitle.trim() || "Project";
  return role === "project_images"
    ? `Parascene Desktop · ${base} · Images`
    : `Parascene Desktop · ${base} · Videos`;
}

export function roleForProjectGroupKind(
  kind: "images" | "videos",
): DesktopProjectGroupRole {
  return kind === "images" ? "project_images" : "project_videos";
}

export function isProjectCabinetId(
  id: string | null | undefined,
  cabinets: ProjectCabinetIds | null | undefined,
): boolean {
  if (!id) return false;
  const sid = String(id).trim();
  if (!sid || !cabinets) return false;
  return (
    sid === String(cabinets.imagesGroupId ?? "").trim() ||
    sid === String(cabinets.videosGroupId ?? "").trim()
  );
}

function desktopMetaFromUnknown(value: unknown): DesktopProjectGroupMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const desktop = (value as Record<string, unknown>)[DESKTOP_GROUP_META_KEY];
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) {
    return null;
  }
  const role = (desktop as { role?: unknown }).role;
  if (role !== "project_images" && role !== "project_videos") return null;
  const client = (desktop as { client?: unknown }).client;
  const projectId = (desktop as { projectId?: unknown }).projectId;
  return {
    role,
    client: client === "parascene-desktop" ? "parascene-desktop" : "parascene-desktop",
    ...(typeof projectId === "string" && projectId.trim()
      ? { projectId: projectId.trim() }
      : {}),
  };
}

/** Read stamped desktop meta from a catalog Creation’s remoteJson. */
export function desktopProjectGroupMetaFromCreation(
  creation: Pick<Creation, "remoteJson"> | null | undefined,
): DesktopProjectGroupMeta | null {
  if (!creation?.remoteJson) return null;
  try {
    const parsed = JSON.parse(creation.remoteJson) as {
      meta?: unknown;
      [key: string]: unknown;
    };
    return (
      desktopMetaFromUnknown(parsed.meta) ??
      desktopMetaFromUnknown(parsed) ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * True when this creation is a desktop project cabinet (meta stamp).
 * Prefer combining with {@link isProjectCabinetId} for open-project certainty.
 */
export function isDesktopProjectGroup(
  creation: Pick<Creation, "remoteJson" | "filename"> | null | undefined,
): boolean {
  if (!creation || !isGroupCreation(creation)) return false;
  return desktopProjectGroupMetaFromCreation(creation) != null;
}

/** Cabinet for Editor behavior: project ids and/or stamped meta. */
export function isEditorProjectCabinet(
  id: string,
  creation: Creation | undefined,
  cabinets: ProjectCabinetIds | null | undefined,
): boolean {
  if (isProjectCabinetId(id, cabinets)) return true;
  return isDesktopProjectGroup(creation);
}
