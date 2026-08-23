/**
 * Remove throwaway Parascene upload-bridge extracts (`local-*` framed stills)
 * from project membership, and clear timeline Form stamps that still point at them.
 *
 * Parascene gens upload a framed extract then keep the Creation still in the
 * Images group. The local extract must not remain as a flat project twin.
 * Blue Direct / Replicate locals are left alone unless a Parascene-blue
 * generation stamp names them as FIRST/LAST.
 */

import type {
  AddAssetFrameSource,
  AddAssetGeneration,
  TimelineClip,
} from "./types";
import type { StoredProject } from "./projectStore";

/** Framed ffmpeg extract titles look like `25762-r-19-fit-404x720-z1000-x0-y0`. */
export const PARASCENE_BRIDGE_EXTRACT_TITLE_RE =
  /-\d+x\d+-z\d+-x-?\d+-y-?\d+$/i;

function isLocalId(id: string | null | undefined): boolean {
  return Boolean(id?.trim().startsWith("local-"));
}

function frameAssetId(
  source: AddAssetFrameSource | null | undefined,
): string | null {
  if (!source || source.kind !== "asset") return null;
  return source.assetId?.trim() || null;
}

function isParasceneGeneration(gen: AddAssetGeneration): boolean {
  const server = (gen.server ?? gen.provider ?? "").trim();
  return server === "parascene_blue" || server === "parascene";
}

/**
 * Local-* ids that Parascene timeline gens still name as FIRST/LAST.
 * Those are upload-bridge extracts, not durable Blue Direct / Replicate inputs.
 */
export function collectParasceneBridgeLocalIds(
  timeline: readonly TimelineClip[] | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const clip of timeline ?? []) {
    const gen = clip.addAssetGeneration;
    if (!gen || !isParasceneGeneration(gen)) continue;
    const start = gen.startFrameAssetId?.trim() || "";
    const first = frameAssetId(gen.firstFrameSource);
    const last = frameAssetId(gen.lastFrameSource);
    for (const id of [start, first, last]) {
      if (isLocalId(id)) out.add(id!);
    }
  }
  return out;
}

export function isParasceneBridgeExtractTitle(
  title: string | null | undefined,
): boolean {
  const t = title?.trim() || "";
  if (!t) return false;
  return (
    PARASCENE_BRIDGE_EXTRACT_TITLE_RE.test(t) ||
    /-(?:fit|fill|stretch)-\d+x\d+/i.test(t)
  );
}

function clearLocalFrameRefs(
  gen: AddAssetGeneration,
  bridgeIds: ReadonlySet<string>,
): AddAssetGeneration {
  let next = gen;
  const start = gen.startFrameAssetId?.trim() || "";
  if (start && bridgeIds.has(start)) {
    next = {
      ...next,
      startFrameAssetId: undefined,
      firstFrameSource: { kind: "none" },
    };
  }
  const first = frameAssetId(next.firstFrameSource);
  if (first && bridgeIds.has(first)) {
    next = { ...next, firstFrameSource: { kind: "none" } };
  }
  const last = frameAssetId(next.lastFrameSource);
  if (last && bridgeIds.has(last)) {
    next = { ...next, lastFrameSource: { kind: "none" } };
  }
  return next;
}

/**
 * Drop Parascene bridge locals from `creationIds` and clear Form stamps that
 * still point at them (preview URL from Parascene meta remains for display).
 *
 * @param extraBridgeIds optional local-* ids known to be framed extracts
 *   (e.g. from catalog titles matching {@link isParasceneBridgeExtractTitle}).
 */
export function stripParasceneBridgeLocals(
  project: StoredProject,
  extraBridgeIds?: Iterable<string>,
): { project: StoredProject; removedIds: string[] } {
  const bridgeIds = collectParasceneBridgeLocalIds(project.timeline);
  for (const id of extraBridgeIds ?? []) {
    if (isLocalId(id)) bridgeIds.add(id.trim());
  }
  if (bridgeIds.size === 0) {
    return { project, removedIds: [] };
  }

  const removedIds = (project.creationIds ?? []).filter((id) =>
    bridgeIds.has(id),
  );
  const creationIds = (project.creationIds ?? []).filter(
    (id) => !bridgeIds.has(id),
  );
  const timeline = (project.timeline ?? []).map((clip) => {
    const gen = clip.addAssetGeneration;
    if (!gen || !isParasceneGeneration(gen)) return clip;
    const healed = clearLocalFrameRefs(gen, bridgeIds);
    if (healed === gen) return clip;
    return { ...clip, addAssetGeneration: healed };
  });

  if (
    removedIds.length === 0 &&
    timeline.every((c, i) => c === (project.timeline ?? [])[i])
  ) {
    return { project, removedIds: [] };
  }

  return {
    project: {
      ...project,
      creationIds,
      timeline,
    },
    removedIds,
  };
}

/** Local-* membership ids whose catalog title looks like a framed extract. */
export function bridgeLocalIdsFromCreationTitles(
  creations: Iterable<{ id?: string | null; title?: string | null }>,
): string[] {
  const out: string[] = [];
  for (const row of creations) {
    const id = row.id?.trim() || "";
    if (!isLocalId(id)) continue;
    if (isParasceneBridgeExtractTitle(row.title)) out.push(id);
  }
  return out;
}
