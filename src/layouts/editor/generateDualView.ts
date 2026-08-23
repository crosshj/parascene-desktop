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
}): boolean {
  return opts.isPlaceholder || Boolean(opts.generation);
}
