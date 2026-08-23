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
 * Filing / ensure recovery matches stamped `meta.desktop.projectId` only when
 * the caller has a project id — never party-name title alone (titles collide).
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

/**
 * True when this cover belongs to the given project + role.
 *
 * When the caller has a project id (normal Editor/Lab filing), match **only**
 * stamped `meta.desktop.projectId`. Party-name title must not claim another
 * project's cabinet — default titles like "Untitled project" collide.
 *
 * Title matching is reserved for orphan recovery when no project id is known.
 */
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
  if (wantId) {
    const stamped = identity.projectId?.trim() || "";
    return Boolean(stamped && stamped === wantId);
  }
  // Orphan / no-id tools only: party-name title match.
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

type CabinetCoverCreation = Pick<
  Creation,
  "id" | "remoteJson" | "filename" | "title" | "createdAt"
>;

/**
 * Assets display: this project's Images/Videos container.
 * Store pointers expand even without a stamp. This helper covers party-name
 * / stamped covers so leftover container cards still expand instead of showing.
 */
export function isProjectContainerCoverForDisplay(
  creation: CabinetCoverCreation | null | undefined,
  opts: { projectId?: string | null; projectTitle?: string | null },
): boolean {
  const identity = identifyDesktopCabinet(creation);
  if (!identity) return false;
  const wantId = opts.projectId?.trim() || "";
  const wantTitle = opts.projectTitle?.trim() || "";
  const stamped = identity.projectId?.trim() || "";
  if (wantId && stamped && stamped === wantId) return true;
  if (wantTitle && identity.projectTitle && identity.projectTitle === wantTitle) {
    return true;
  }
  return false;
}

type CabinetCoverCand = { id: string; createdAt: string };

function collectOpenProjectCabinetCovers(opts: {
  projectId: string;
  projectTitle?: string | null;
  creations: readonly CabinetCoverCreation[];
}): { images: CabinetCoverCand[]; videos: CabinetCoverCand[] } {
  const want = opts.projectId.trim();
  if (!want) return { images: [], videos: [] };

  const images: CabinetCoverCand[] = [];
  const videos: CabinetCoverCand[] = [];
  for (const creation of opts.creations) {
    const identity = identifyDesktopCabinet(creation);
    if (!identity) continue;
    if (
      !matchesDesktopCabinetProject(identity, {
        role: identity.role,
        projectId: want,
        projectTitle: opts.projectTitle,
      })
    ) {
      continue;
    }
    const id = String(creation.id).trim();
    if (!id) continue;
    const row = { id, createdAt: creation.createdAt || "" };
    if (identity.role === "project_images") images.push(row);
    else if (identity.role === "project_videos") videos.push(row);
  }
  return { images, videos };
}

function pickNewestCabinetCover(
  cands: readonly CabinetCoverCand[],
): string | undefined {
  if (cands.length === 0) return undefined;
  return [...cands].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    ?.id;
}

/**
 * When store pointers were cleared but stamped cabinet covers remain among
 * project assets, recover `imagesGroupId` / `videosGroupId` so Editor Assets
 * can expand them. Match stamped `projectId` only — never party title.
 */
export function recoverMissingCabinetIdsFromCreations(opts: {
  projectId: string;
  projectTitle?: string | null;
  imagesGroupId?: string | null;
  videosGroupId?: string | null;
  creations: readonly CabinetCoverCreation[];
}): { imagesGroupId?: string; videosGroupId?: string } {
  const want = opts.projectId.trim();
  const needImages = !opts.imagesGroupId?.trim();
  const needVideos = !opts.videosGroupId?.trim();
  if (!want || (!needImages && !needVideos)) return {};

  const { images, videos } = collectOpenProjectCabinetCovers(opts);
  const out: { imagesGroupId?: string; videosGroupId?: string } = {};
  if (needImages) {
    const id = pickNewestCabinetCover(images);
    if (id) out.imagesGroupId = id;
  }
  if (needVideos) {
    const id = pickNewestCabinetCover(videos);
    if (id) out.videosGroupId = id;
  }
  return out;
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
