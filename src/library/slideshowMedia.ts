import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  normalizeSlideshowMode,
  type SlideshowMode,
  type SlideshowRecipe,
} from "../project/types";
import type { StagedClipFraming } from "../layouts/editor/stagedClip";
import type { ProjectAspectRatio } from "../project/aspectRatios";

export type SlideshowEnsureInput = {
  imageAssetIds: string[];
  mode: SlideshowMode;
  random?: boolean;
  seed?: number;
  durationSec: number;
  framing?: StagedClipFraming | string | null;
  aspectRatio: ProjectAspectRatio | string;
  clipStartSec: number;
  audioAssetId?: string;
  audioInSec?: number;
  audioOutSec?: number;
  audioStartSec?: number;
  audioEndSec?: number;
  sensitivity?: number;
};

export type SlideshowEnsureResult = {
  bakeKey: string;
  path: string;
  durationSec: number;
};

export type BakeStatus = "idle" | "generating" | "ready" | "failed";

export type BakeInfo = {
  status: BakeStatus;
  /** Present when status is "failed". */
  error?: string | null;
};

export function formatBakeError(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return "Slideshow render failed";
}

const resolved = new Map<string, SlideshowEnsureResult>();
const inflight = new Map<string, Promise<SlideshowEnsureResult>>();

export function slideshowEnsureInputFromRecipe(opts: {
  recipe: SlideshowRecipe;
  durationSec: number;
  framing?: StagedClipFraming | string | null;
  aspectRatio: ProjectAspectRatio | string;
  clipStartSec: number;
}): SlideshowEnsureInput {
  const { recipe } = opts;
  return {
    imageAssetIds: recipe.imageAssetIds,
    mode: normalizeSlideshowMode(recipe.mode),
    random: recipe.random === true,
    seed: recipe.random ? recipe.seed : undefined,
    durationSec: opts.durationSec,
    framing: opts.framing ?? "fit",
    aspectRatio: opts.aspectRatio,
    clipStartSec: opts.clipStartSec,
    audioAssetId: recipe.audioAssetId,
    audioInSec: recipe.audioInSec,
    audioOutSec: recipe.audioOutSec,
    audioStartSec: recipe.audioStartSec,
    audioEndSec: recipe.audioEndSec,
    sensitivity: recipe.sensitivity,
  };
}

export function mediaUrlForBakePath(path: string): string {
  return convertFileSrc(path, "media");
}

export async function ensureSlideshowMedia(
  input: SlideshowEnsureInput,
): Promise<SlideshowEnsureResult> {
  const cacheKey = JSON.stringify(input);
  const hit = resolved.get(cacheKey);
  if (hit) return hit;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const promise = invoke<SlideshowEnsureResult>("library_ensure_slideshow", {
    input,
  })
    .then((result) => {
      resolved.set(cacheKey, result);
      inflight.delete(cacheKey);
      return result;
    })
    .catch((error) => {
      inflight.delete(cacheKey);
      throw error;
    });
  inflight.set(cacheKey, promise);
  return promise;
}

export function invalidateSlideshowMedia(): void {
  resolved.clear();
  inflight.clear();
}
