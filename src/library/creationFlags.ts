import type { Creation } from "./types";

/** Parascene group cover row (`meta.group.kind === "group_creations"`). */
export function isGroupCreation(c: {
  remoteJson?: string | null;
  filename?: string | null;
}): boolean {
  if (c.filename?.trim().toLowerCase().startsWith("group/")) return true;
  if (!c.remoteJson) return false;
  try {
    const parsed = JSON.parse(c.remoteJson) as {
      meta?: { group?: { kind?: string } };
      group?: { kind?: string };
    };
    const kind =
      parsed?.meta?.group?.kind ?? parsed?.group?.kind ?? null;
    return kind === "group_creations";
  } catch {
    return false;
  }
}

type GroupMeta = {
  source_creation_ids?: unknown;
  source_creations?: Array<{ id?: unknown } | string | number>;
};

function parseGroupMeta(remoteJson: string): GroupMeta | null {
  try {
    const parsed = JSON.parse(remoteJson) as {
      meta?: { group?: GroupMeta };
      group?: GroupMeta;
    };
    return parsed.meta?.group ?? parsed.group ?? null;
  } catch {
    return null;
  }
}

function idFromUnknown(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
}

/** Ordered source creation ids stored by a Parascene group cover row. */
export function groupSourceCreationIds(c: {
  remoteJson?: string | null;
}): string[] {
  if (!c.remoteJson) return [];
  const group = parseGroupMeta(c.remoteJson);
  if (!group) return [];

  // Prefer the explicit ordered id list when present.
  const fromIds = Array.isArray(group.source_creation_ids)
    ? group.source_creation_ids.map(idFromUnknown).filter(Boolean)
    : [];
  if (fromIds.length > 0) return [...new Set(fromIds)];

  const sources = group.source_creations ?? [];
  const ids = sources
    .map((source) => {
      const value =
        source && typeof source === "object" && "id" in source
          ? source.id
          : source;
      return idFromUnknown(value);
    })
    .filter(Boolean);
  return [...new Set(ids)];
}

/**
 * Embedded group member rows from `meta.group.source_creations`.
 * These often exist only on the cover row — not as separate catalog entries.
 */
export function groupEmbeddedSourceCreations(c: {
  remoteJson?: string | null;
}): Record<string, unknown>[] {
  if (!c.remoteJson) return [];
  const group = parseGroupMeta(c.remoteJson);
  const sources = group?.source_creations;
  if (!Array.isArray(sources)) return [];
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const id = idFromUnknown((source as { id?: unknown }).id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...(source as Record<string, unknown>), id });
  }
  return out;
}

/**
 * All creation ids that belong inside a group cover.
 * These should not appear as separate Creations-board tiles.
 */
export function collectGroupMemberIds(
  creations: ReadonlyArray<{
    id: string;
    remoteJson?: string | null;
    filename?: string | null;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const creation of creations) {
    if (!isGroupCreation(creation)) continue;
    for (const id of groupSourceCreationIds(creation)) {
      if (id && id !== creation.id) out.add(id);
    }
  }
  return out;
}

/** Hide group members from Library home (covers stay; open the group to browse). */
export function omitGroupMemberCreations<T extends { id: string }>(
  creations: readonly T[],
  memberIds: ReadonlySet<string>,
): T[] {
  if (memberIds.size === 0) return [...creations];
  return creations.filter((c) => !memberIds.has(c.id));
}

export function isPublishedCreation(c: Pick<Creation, "published">): boolean {
  return c.published === true;
}

/**
 * Hover-overlay title: real API title only. Filename / `Creation {id}` fallbacks
 * count as untitled.
 */
export function creationCardTitle(c: {
  id: string;
  title: string;
  filename?: string | null;
  remoteJson?: string | null;
}): { text: string; untitled: boolean } {
  let fromRemote: string | null = null;
  if (c.remoteJson) {
    try {
      const parsed = JSON.parse(c.remoteJson) as { title?: unknown };
      if (typeof parsed.title === "string" && parsed.title.trim()) {
        fromRemote = parsed.title.trim();
      }
    } catch {
      // ignore
    }
  }
  const raw = (fromRemote ?? c.title ?? "").trim();
  if (!raw) return { text: "Untitled", untitled: true };
  if (raw === `Creation ${c.id}`) return { text: "Untitled", untitled: true };
  const filename = c.filename?.trim() ?? "";
  if (filename && raw === filename) return { text: "Untitled", untitled: true };
  return { text: raw, untitled: false };
}
