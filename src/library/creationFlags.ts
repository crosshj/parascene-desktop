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
