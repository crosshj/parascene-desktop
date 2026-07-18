import type { Project } from "../../project/types";
import {
  parseStagedClipPayload,
  serializeStagedClip,
  timelineClipToStagedDraft,
  type StagedClipDraft,
} from "./stagedClip";

export type EditorSelectionState = {
  selectedAssetId: string | null;
  selectedAssetIds: string[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  clipStagingSeed: { clipId: string; draft: StagedClipDraft } | null;
  /** Source-only staging restored from the project when no clip is selected. */
  pendingStagedDraft: StagedClipDraft | null;
};

function emptySelection(): EditorSelectionState {
  return {
    selectedAssetId: null,
    selectedAssetIds: [],
    selectedClipId: null,
    selectedClipIds: [],
    clipStagingSeed: null,
    pendingStagedDraft: null,
  };
}

/** True when a pending source draft still matches the current asset selection. */
export function pendingDraftMatchesSelection(
  draft: StagedClipDraft | null | undefined,
  selectedAssetIds: readonly string[],
): boolean {
  if (!draft) return false;
  const ids = selectedAssetIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return false;
  if (draft.kind === "slideshow") {
    const recipeIds = draft.slideshow?.imageAssetIds ?? [];
    if (recipeIds.length !== ids.length) return false;
    return recipeIds.every((id, i) => id === ids[i]);
  }
  return ids.length === 1 && draft.assetId === ids[0];
}

export function normalizePendingStagedDraft(
  value: unknown,
): StagedClipDraft | null {
  if (!value) return null;
  if (typeof value === "string") return parseStagedClipPayload(value);
  try {
    return parseStagedClipPayload(serializeStagedClip(value as StagedClipDraft));
  } catch {
    return null;
  }
}

/**
 * Rebuild editor selection + staging from persisted project fields.
 * Used on Editor mount and when the open project id changes.
 */
export function selectionFromProject(project: Project): EditorSelectionState {
  const savedClipId = project.selectedTimelineClipId;
  if (savedClipId) {
    const clip = project.timeline.find((c) => c.id === savedClipId);
    if (clip) {
      const draft = timelineClipToStagedDraft(clip);
      return {
        selectedAssetId: null,
        selectedAssetIds: [],
        selectedClipId: clip.id,
        selectedClipIds: [clip.id],
        clipStagingSeed: draft ? { clipId: clip.id, draft } : null,
        pendingStagedDraft: null,
      };
    }
  }

  const savedAssetId = project.selectedAssetId;
  if (
    savedAssetId &&
    project.assets.some((asset) => asset.id === savedAssetId)
  ) {
    const pending = normalizePendingStagedDraft(project.pendingStagedDraft);
    const pendingIds = pending?.slideshow?.imageAssetIds ?? [];
    // Multi-select slideshow drafts carry the full selection; restore it when
    // the persisted primary asset is still one of the members.
    const selectedAssetIds =
      pending?.kind === "slideshow" &&
      pendingIds.length >= 2 &&
      pendingIds.includes(savedAssetId)
        ? [...pendingIds]
        : [savedAssetId];
    const pendingStagedDraft = pendingDraftMatchesSelection(
      pending,
      selectedAssetIds,
    )
      ? pending
      : null;
    return {
      selectedAssetId: savedAssetId,
      selectedAssetIds,
      selectedClipId: null,
      selectedClipIds: [],
      clipStagingSeed: null,
      pendingStagedDraft,
    };
  }

  return emptySelection();
}
