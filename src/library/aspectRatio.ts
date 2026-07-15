import { isGroupCreation } from "./creationFlags";
import type { Creation } from "./types";

export type AspectParts = { w: number; h: number };

const PRESETS: Record<string, AspectParts> = {
  "1:1": { w: 1, h: 1 },
  "4:5": { w: 4, h: 5 },
  "9:16": { w: 9, h: 16 },
  "16:9": { w: 16, h: 9 },
  "3:2": { w: 3, h: 2 },
  "2:3": { w: 2, h: 3 },
  "5:4": { w: 5, h: 4 },
};

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Reduce e.g. 576:1024 → 9:16. */
export function reduceAspect(parts: AspectParts): AspectParts {
  const d = gcd(parts.w, parts.h);
  return { w: parts.w / d, h: parts.h / d };
}

/** Parse `"16:9"` / `"1:1"` into numeric parts. */
export function parseAspectRatioString(raw: string | null | undefined): AspectParts | null {
  if (!raw) return null;
  const key = raw.trim();
  if (!key) return null;
  if (PRESETS[key]) return PRESETS[key];
  const match = key.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

/**
 * Creative ratios (9:16, 4:5, …) vs accidental pixel dumps stored as "1024:1024".
 * Only trust named presets or small-integer ratios — not large WxH pixel pairs
 * that happen to reduce to 1:1.
 */
function isCreativeRatioString(raw: string, parts: AspectParts): boolean {
  if (PRESETS[raw.trim()]) return true;
  return parts.w <= 64 && parts.h <= 64;
}

function aspectFromRemoteJson(remoteJson: string | null | undefined): AspectParts | null {
  if (!remoteJson) return null;
  try {
    const parsed = JSON.parse(remoteJson) as { meta?: unknown };
    const raw = aspectRatioFromMeta(parsed.meta);
    return raw ? parseAspectRatioString(raw) : null;
  } catch {
    return null;
  }
}

function partsFromWidthHeight(
  width: unknown,
  height: unknown,
): AspectParts | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) return null;
  return reduceAspect({ w, h });
}

/**
 * Group cover pixels from `meta.group.source_creations` (cover member first).
 * Group creatives often inherit a wrong `meta.args.aspect_ratio` from the pack
 * template; the cover image is what the board shows.
 */
function aspectFromGroupCover(remoteJson: string | null | undefined): AspectParts | null {
  if (!remoteJson) return null;
  try {
    const parsed = JSON.parse(remoteJson) as {
      meta?: {
        group?: {
          cover_source_id?: unknown;
          source_creations?: Array<{
            id?: unknown;
            width?: unknown;
            height?: unknown;
            meta?: unknown;
          }>;
        };
      };
    };
    const group = parsed.meta?.group;
    const sources = group?.source_creations;
    if (!Array.isArray(sources) || sources.length === 0) return null;
    const coverId = group?.cover_source_id;
    const cover =
      (typeof coverId === "string" || typeof coverId === "number"
        ? sources.find((s) => String(s?.id) === String(coverId))
        : null) ?? sources[0];
    const fromPx = partsFromWidthHeight(cover?.width, cover?.height);
    if (fromPx) return fromPx;
    const fromArgs = aspectRatioFromMeta(cover?.meta);
    return fromArgs ? parseAspectRatioString(fromArgs) : null;
  } catch {
    return null;
  }
}

/**
 * Slot aspect for the board: 9:16 ⇒ column width 1, height 16/9.
 *
 * Never trust thumbnail pixel size — Parascene thumbs are often square even
 * when the creation is 9:16 / 4:5. Prefer creative metadata for singles:
 * creative aspect_ratio → meta.args in remote_json → width/height.
 *
 * Groups use the cover image aspect instead: cover width/height (and
 * `source_creations`) beat pack-level `meta.args.aspect_ratio`, which is
 * frequently wrong for square covers.
 */
export function aspectRatioFromCreation(c: {
  width?: number | null;
  height?: number | null;
  aspectRatio?: string | null;
  remoteJson?: string | null;
  filename?: string | null;
}): AspectParts {
  const group = isGroupCreation(c);
  const fromPixels = partsFromWidthHeight(c.width, c.height);

  if (group) {
    if (fromPixels) return fromPixels;
    const fromCover = aspectFromGroupCover(c.remoteJson ?? null);
    if (fromCover) return reduceAspect(fromCover);
  }

  const fromArg = parseAspectRatioString(c.aspectRatio);
  if (fromArg && c.aspectRatio && isCreativeRatioString(c.aspectRatio, fromArg)) {
    return reduceAspect(fromArg);
  }

  const fromJson = aspectFromRemoteJson(c.remoteJson ?? null);
  if (fromJson) return reduceAspect(fromJson);

  if (fromPixels) return fromPixels;

  // Last resort: denormalized aspect_ratio even if it looks like a pixel dump.
  if (fromArg) return reduceAspect(fromArg);

  return { w: 1, h: 1 };
}

/** CSS `aspect-ratio` value, e.g. `"9 / 16"`. */
export function creationAspectCss(c: Creation): string {
  const { w, h } = aspectRatioFromCreation(c);
  return `${w} / ${h}`;
}

/**
 * Relative height for unit-width column packing.
 * Column width 1 ⇒ card height N for an aspect w:h where N = h/w.
 */
export function creationPackHeight(c: Creation): number {
  const { w, h } = aspectRatioFromCreation(c);
  return h / w;
}

/** Pull aspect_ratio from API meta.args when present. */
export function aspectRatioFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const args = (meta as { args?: unknown }).args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const raw = (args as { aspect_ratio?: unknown }).aspect_ratio;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return parseAspectRatioString(raw) ? raw.trim() : null;
}
