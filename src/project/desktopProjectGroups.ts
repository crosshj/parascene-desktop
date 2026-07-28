/**
 * Desktop “cabinet” groups — Images/Videos filing for a project so Parascene’s
 * creations feed stays uncluttered. Distinct from creative image packs that
 * stay as group covers in Editor Assets.
 *
 * Editor expansion uses project store ids only (`imagesGroupId` /
 * `videosGroupId`). Stamped meta is for Parascene recovery / labeling — it does
 * not expand every desktop-stamped group in the Assets pane.
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

const DESKTOP_PARTY_NAME_RE =
  /^Parascene Desktop · (.+) · (Images|Videos)$/;

/** Parse a Parascene Desktop cabinet party name into title + role. */
export function parseDesktopCabinetPartyName(
  title: string | null | undefined,
): { projectTitle: string; role: DesktopProjectGroupRole } | null {
  const raw = String(title ?? "").trim();
  if (!raw) return null;
  const match = DESKTOP_PARTY_NAME_RE.exec(raw);
  if (!match) return null;
  const projectTitle = match[1]?.trim();
  if (!projectTitle) return null;
  const role: DesktopProjectGroupRole =
    match[2] === "Videos" ? "project_videos" : "project_images";
  return { projectTitle, role };
}

export function roleForProjectGroupKind(
  kind: "images" | "videos",
): DesktopProjectGroupRole {
  return kind === "images" ? "project_images" : "project_videos";
}

export function projectGroupKindForRole(
  role: DesktopProjectGroupRole,
): "images" | "videos" {
  return role === "project_images" ? "images" : "videos";
}

/**
 * Identify a desktop cabinet from meta stamp and/or party-name pattern.
 * Meta wins for role/projectId; party name fills gaps when the API dropped meta.
 */
export function identifyDesktopCabinet(
  creation: Pick<Creation, "remoteJson" | "filename" | "title"> | null | undefined,
): {
  role: DesktopProjectGroupRole;
  projectId?: string;
  projectTitle?: string;
} | null {
  if (!creation || !isGroupCreation(creation)) return null;
  const meta = desktopProjectGroupMetaFromCreation(creation);
  const fromTitle = parseDesktopCabinetPartyName(creation.title);
  if (!meta && !fromTitle) return null;
  const role = meta?.role ?? fromTitle!.role;
  const projectId = meta?.projectId?.trim() || undefined;
  const projectTitle = fromTitle?.projectTitle;
  return {
    role,
    ...(projectId ? { projectId } : {}),
    ...(projectTitle ? { projectTitle } : {}),
  };
}

/**
 * Bucket key for dedupe: prefer stamped projectId, else `title:{party title}`.
 */
export function desktopCabinetProjectKey(opts: {
  projectId?: string | null;
  projectTitle?: string | null;
}): string | null {
  const pid = opts.projectId?.trim();
  if (pid) return `id:${pid}`;
  const title = opts.projectTitle?.trim();
  if (title) return `title:${title}`;
  return null;
}

/** True when this cover belongs to the given project + role. */
export function matchesDesktopCabinetProject(
  identity: {
    role: DesktopProjectGroupRole;
    projectId?: string;
    projectTitle?: string;
  },
  opts: {
    role: DesktopProjectGroupRole;
    projectId?: string | null;
    projectTitle?: string | null;
  },
): boolean {
  if (identity.role !== opts.role) return false;
  const wantId = opts.projectId?.trim() || "";
  const wantTitle = opts.projectTitle?.trim() || "";
  // Prefer stamped projectId when both sides have it.
  if (identity.projectId && wantId) {
    return identity.projectId === wantId;
  }
  // Party-name title match when meta projectId is missing.
  if (wantTitle && identity.projectTitle) {
    return identity.projectTitle === wantTitle;
  }
  return false;
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

/**
 * Editor expands **only** this project's Images/Videos source cabinets.
 * Ordinary groups (even other desktop-stamped covers) stay as single covers.
 */
export function isEditorProjectCabinet(
  id: string,
  _creation: Creation | undefined,
  cabinets: ProjectCabinetIds | null | undefined,
): boolean {
  return isProjectCabinetId(id, cabinets);
}
