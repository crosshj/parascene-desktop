import type {
  AddAssetDraft,
  AddAssetGeneration,
  ProjectAspectRatio,
} from "./types";
import { DEFAULT_PROJECT_ASPECT_RATIO, isProjectAspectRatio } from "./aspectRatios";

export type LibraryAssetPlaceholderStatus = "generating" | "done" | "error";

/** In-flight or recently finished Generate → Assets target on a project asset id. */
export type LibraryAssetPlaceholder = {
  id: string;
  kind: "image";
  aspectRatio: ProjectAspectRatio;
  status: LibraryAssetPlaceholderStatus;
  addAssetDraft: AddAssetDraft;
  addAssetGeneration?: AddAssetGeneration;
  /** Latest progress line for Result pane while generating. */
  progressNote?: string;
  createdAt: string;
  updatedAt: string;
};

export function normalizeLibraryAssetPlaceholder(
  value: unknown,
): LibraryAssetPlaceholder | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;
  const draft = row.addAssetDraft;
  if (!draft || typeof draft !== "object") return null;
  const status =
    row.status === "done" || row.status === "error" || row.status === "generating"
      ? row.status
      : "generating";
  const aspectRatio = isProjectAspectRatio(row.aspectRatio)
    ? row.aspectRatio
    : DEFAULT_PROJECT_ASPECT_RATIO;
  const createdAt =
    typeof row.createdAt === "string" && row.createdAt.trim()
      ? row.createdAt.trim()
      : new Date().toISOString();
  const updatedAt =
    typeof row.updatedAt === "string" && row.updatedAt.trim()
      ? row.updatedAt.trim()
      : createdAt;
  const generation =
    row.addAssetGeneration && typeof row.addAssetGeneration === "object"
      ? (row.addAssetGeneration as AddAssetGeneration)
      : undefined;
  const progressNote =
    typeof row.progressNote === "string" && row.progressNote.trim()
      ? row.progressNote.trim()
      : undefined;
  return {
    id,
    kind: "image",
    aspectRatio,
    status,
    addAssetDraft: draft as AddAssetDraft,
    addAssetGeneration: generation,
    progressNote,
    createdAt,
    updatedAt,
  };
}

export function normalizeLibraryAssetPlaceholders(
  value: unknown,
): Record<string, LibraryAssetPlaceholder> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, LibraryAssetPlaceholder> = {};
  for (const [key, row] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeLibraryAssetPlaceholder(
      row && typeof row === "object" ? { ...(row as object), id: key } : null,
    );
    if (normalized) out[normalized.id] = normalized;
  }
  return out;
}

export function resolveLibraryAssetPlaceholder(
  placeholders: Record<string, LibraryAssetPlaceholder> | undefined,
  assetId: string | null | undefined,
): LibraryAssetPlaceholder | null {
  const id = assetId?.trim();
  if (!id || !placeholders) return null;
  return placeholders[id] ?? null;
}

/** Provisional Generate → Assets rows that are not finished creations yet. */
export function isActiveLibraryAssetPlaceholder(
  placeholder: LibraryAssetPlaceholder | null | undefined,
): boolean {
  return placeholder != null && placeholder.status !== "done";
}

export function libraryAssetPlaceholderIdsInList(
  placeholders: Record<string, LibraryAssetPlaceholder> | undefined,
  assetIds: readonly string[],
): string[] {
  const map = normalizeLibraryAssetPlaceholders(placeholders);
  return assetIds.filter((id) => Boolean(map[id.trim()]));
}

/** Result-pane phase. Finished generations drop the placeholder and use the normal asset preview. */
export function libraryAssetPlaceholderPhase(
  placeholder: LibraryAssetPlaceholder | null | undefined,
): "pre_gen" | "running" | "done" | "error" {
  if (!placeholder) return "pre_gen";
  if (placeholder.status === "done") return "done";
  if (placeholder.status === "error") return "error";
  if (placeholder.addAssetDraft.lastError?.trim()) return "error";
  const job = placeholder.addAssetDraft.generationJob;
  if (
    job?.status === "starting" ||
    job?.status === "waiting" ||
    job?.status === "downloading" ||
    job?.status === "importing"
  ) {
    return "running";
  }
  return "pre_gen";
}

/** Active placeholders in stable grid order (creation time, then id). */
export function activeLibraryAssetPlaceholders(
  placeholders: Record<string, LibraryAssetPlaceholder> | undefined,
): LibraryAssetPlaceholder[] {
  return Object.values(normalizeLibraryAssetPlaceholders(placeholders))
    .filter((row) => isActiveLibraryAssetPlaceholder(row))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}

/** Remote creation ids still owned by an in-flight placeholder tile. */
export function pendingLibraryPlaceholderCreationIds(
  placeholders: readonly LibraryAssetPlaceholder[],
): Set<string> {
  const ids = new Set<string>();
  for (const placeholder of placeholders) {
    const pending =
      placeholder.addAssetDraft.generationJob?.pendingCreationId?.trim();
    if (pending) ids.add(pending);
  }
  return ids;
}

export function libraryAssetPlaceholderDisplayName(
  placeholder: LibraryAssetPlaceholder,
): string {
  return (
    placeholder.addAssetDraft.prompt?.trim().slice(0, 48) || placeholder.id
  );
}
