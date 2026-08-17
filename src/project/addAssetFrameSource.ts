/**
 * Parse / migrate generate still sources (timeline neighbor, Assets, or none).
 */

import type { AddAssetFrameSource, AddAssetGenerationMode } from "./types";

export function parseAddAssetFrameSource(
  value: unknown,
): AddAssetFrameSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind === "timeline") return { kind: "timeline" };
  if (row.kind === "none") return { kind: "none" };
  if (row.kind === "asset") {
    const assetId =
      typeof row.assetId === "string" && row.assetId.trim()
        ? row.assetId.trim()
        : "";
    if (!assetId) return undefined;
    return { kind: "asset", assetId };
  }
  return undefined;
}

/**
 * Prefer explicit firstFrameSource; else migrate legacy startFrameAssetId to
 * an asset source.
 */
export function resolveFirstFrameSource(opts: {
  firstFrameSource?: unknown;
  startFrameAssetId?: unknown;
}): AddAssetFrameSource | undefined {
  const parsed = parseAddAssetFrameSource(opts.firstFrameSource);
  if (parsed) return parsed;
  const assetId =
    typeof opts.startFrameAssetId === "string" && opts.startFrameAssetId.trim()
      ? opts.startFrameAssetId.trim()
      : "";
  if (assetId) return { kind: "asset", assetId };
  return undefined;
}

/**
 * Prefer an Assets image id when the still came from a project image (picker
 * or image neighbor). Do not promote video neighbors — those need a specific
 * frame time; preview URLs / imported stills carry that instead.
 */
export function durableFrameSourceFromPreview(
  preview:
    | {
        sourceAssetId?: string | null;
        sourceIsImage?: boolean | null;
      }
    | null
    | undefined,
  fallback: AddAssetFrameSource | undefined,
): AddAssetFrameSource | undefined {
  if (fallback?.kind === "asset") return fallback;
  const assetId = preview?.sourceAssetId?.trim();
  if (assetId && preview?.sourceIsImage) {
    return { kind: "asset", assetId };
  }
  return fallback;
}

/**
 * Prefer explicit lastFrameSource; else migrate legacy continuityMode
 * `first_last` → timeline neighbor, otherwise none.
 */
export function resolveLastFrameSource(opts: {
  lastFrameSource?: unknown;
  continuityMode?: unknown;
}): AddAssetFrameSource {
  const parsed = parseAddAssetFrameSource(opts.lastFrameSource);
  if (parsed) return parsed;
  if (opts.continuityMode === "first_last") return { kind: "timeline" };
  return { kind: "none" };
}

/** Continuity implied by first/last slot choices (ignores motion_match). */
export function continuityFromFrameSources(
  first: AddAssetFrameSource | null | undefined,
  last: AddAssetFrameSource | null | undefined,
): Extract<AddAssetGenerationMode, "none" | "start_frame" | "first_last"> {
  const firstOn = Boolean(first && first.kind !== "none");
  const lastOn = Boolean(last && last.kind !== "none");
  if (firstOn && lastOn) return "first_last";
  if (firstOn) return "start_frame";
  return "none";
}

export function frameSourceIsSet(
  source: AddAssetFrameSource | null | undefined,
): boolean {
  return Boolean(source && source.kind !== "none");
}

/** Effective asset id when the first/start source is an Assets pick. */
export function frameSourceAssetId(
  source: AddAssetFrameSource | null | undefined,
): string | null {
  if (source?.kind === "asset" && source.assetId.trim()) {
    return source.assetId.trim();
  }
  return null;
}

export function frameSourcesEqual(
  a: AddAssetFrameSource | null | undefined,
  b: AddAssetFrameSource | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "timeline" || a.kind === "none") return true;
  return a.assetId === (b as { kind: "asset"; assetId: string }).assetId;
}
