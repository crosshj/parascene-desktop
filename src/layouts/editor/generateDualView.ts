/** Result | Form dual-view helpers for generate-capable preview hosts. */

import type { AddAssetGeneration, TimelineClip } from "../../project/types";
import type { AddAssetGenerationSession } from "./addAssetGenerate";
import { isAddAssetPlaceholderClip } from "./stagedClip";

export type GenerateDualViewId = "result" | "form";

export type GenerateDualPhase =
  | "pre_gen"
  | "running"
  | "done"
  | "error";

/** UI state for library (Assets) generates hosted by Result | Form dual view. */
export type LibraryGenerateUiState = {
  phase: GenerateDualPhase;
  progressNote: string;
  errorMessage?: string | null;
  startedAtMs?: number;
  /** Creation id of the finished still/video for Result preview. */
  resultCreationId?: string | null;
  /** Preview / detail URL when already known (avoids a second catalog hop). */
  resultPreviewUrl?: string | null;
};

export function defaultGenerateDualView(
  phase: GenerateDualPhase,
): GenerateDualViewId {
  if (phase === "pre_gen" || phase === "error") return "form";
  return "result";
}

/** Result | Form chrome only after generate starts or a finished result exists. */
export function shouldShowGenerateDualChrome(
  phase: GenerateDualPhase,
): boolean {
  return phase !== "pre_gen";
}

/**
 * Keep Result | Form when moving between finished generated assets so browsing
 * provenance does not bounce back to Result.
 */
export function shouldPreserveGenerateDualView(opts: {
  prevHostKey: string | null | undefined;
  nextHostKey: string | null | undefined;
}): boolean {
  const prev = opts.prevHostKey?.trim() || "";
  const next = opts.nextHostKey?.trim() || "";
  return prev.startsWith("gen:") && next.startsWith("gen:");
}

/**
 * While Form is sticky across gen→gen asset clicks, the next creation may not
 * match yet. Hold Form (not Result media) so the image does not flash.
 */
export function shouldHoldGenerateDualFormSurface(opts: {
  view: GenerateDualViewId;
  /** Last dual host key — `gen:…` means we were reviewing a finished gen. */
  hostKey: string | null | undefined;
  /** True once the newly selected asset's done-gen dual host is ready. */
  doneGenerateDualReady: boolean;
  hasAssetId: boolean;
  isAggregateSelection?: boolean;
  /**
   * Catalog row matches the selected asset — not mid-load. When settled and the
   * asset is not generate-hosted, stop holding the Form loading surface (show
   * preview instead). Does not reset the remembered Form | Result tab.
   */
  selectionSettled?: boolean;
}): boolean {
  if (opts.view !== "form") return false;
  if (opts.doneGenerateDualReady) return false;
  if (opts.isAggregateSelection) return false;
  if (!opts.hasAssetId) return false;
  if (!(opts.hostKey?.trim() || "").startsWith("gen:")) return false;
  if (opts.selectionSettled) return false;
  return true;
}

export function resolveGenerateDualPhase(opts: {
  placeholder?: TimelineClip | null;
  session?: AddAssetGenerationSession | null;
  generation?: AddAssetGeneration | null;
}): GenerateDualPhase {
  const { placeholder, session, generation } = opts;
  if (placeholder && isAddAssetPlaceholderClip(placeholder)) {
    const clipSession =
      session?.clipId === placeholder.id ? session : null;
    if (clipSession?.phase === "running") return "running";
    if (clipSession?.phase === "error") return "error";
    if (placeholder.addAssetDraft?.lastError?.trim()) return "error";
    const job = placeholder.addAssetDraft?.generationJob;
    if (job?.status === "starting" || job?.status === "waiting") {
      return "running";
    }
    return "pre_gen";
  }
  if (generation?.creationId?.trim() || generation?.prompt != null) {
    return "done";
  }
  return "pre_gen";
}

/** Selection can host Result | Form chrome. */
export function selectionSupportsGenerateDualView(opts: {
  isPlaceholder: boolean;
  generation: AddAssetGeneration | null | undefined;
  /**
   * Multi-select, group cover, or any aggregate — Form is for one generation
   * subject, never a pile of assets.
   */
  isAggregateSelection?: boolean;
  /** True when the focused catalog row is a group cover. */
  isGroupCover?: boolean;
  /** Focused asset id; must match generation.creationId when both set. */
  selectedCreationId?: string | null;
}): boolean {
  if (opts.isAggregateSelection || opts.isGroupCover) return false;
  if (opts.isPlaceholder) return true;
  if (!opts.generation) return false;
  const genId = opts.generation.creationId?.trim() || "";
  const selected = opts.selectedCreationId?.trim() || "";
  if (selected && genId && selected !== genId) return false;
  return true;
}
