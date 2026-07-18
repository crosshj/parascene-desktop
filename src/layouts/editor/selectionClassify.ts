import type { Creation } from "../../library/types";
import { kindFromMediaType } from "./stagingKind";
import type { StagedClipKind } from "./stagedClip";

export type SelectionMediaKind = StagedClipKind;

export type MultiSelectionClass =
  | { type: "single"; assetId: string; kind: SelectionMediaKind }
  | { type: "compositeImages"; imageAssetIds: string[] }
  | { type: "unsupportedVideos"; videoAssetIds: string[] }
  | { type: "unsupportedMixed"; reason: "imageVideo" | "containsAudio" };

/**
 * Classify an ordered multi-selection for Preview staging.
 * Empty selection is handled by the caller (no preview).
 */
export function classifyAssetSelection(
  orderedIds: readonly string[],
  creationsById: ReadonlyMap<string, Creation>,
): MultiSelectionClass | null {
  const ids = orderedIds.map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return null;

  const kinds: SelectionMediaKind[] = [];
  for (const id of ids) {
    const creation = creationsById.get(id);
    if (!creation) return null; // still loading
    kinds.push(kindFromMediaType(creation.mediaType));
  }

  if (ids.length === 1) {
    return { type: "single", assetId: ids[0], kind: kinds[0] };
  }

  if (kinds.some((k) => k === "audio")) {
    return { type: "unsupportedMixed", reason: "containsAudio" };
  }

  const allImages = kinds.every((k) => k === "image");
  if (allImages) {
    return { type: "compositeImages", imageAssetIds: ids };
  }

  const allVideos = kinds.every((k) => k === "video");
  if (allVideos) {
    return { type: "unsupportedVideos", videoAssetIds: ids };
  }

  return { type: "unsupportedMixed", reason: "imageVideo" };
}

export function unsupportedSelectionMessage(
  classification: Extract<
    MultiSelectionClass,
    { type: "unsupportedVideos" | "unsupportedMixed" }
  >,
): { title: string; body: string } {
  if (classification.type === "unsupportedVideos") {
    return {
      title: "Multi-video clips not supported yet",
      body: `You selected ${classification.videoAssetIds.length} videos. Preview one video at a time, or select only images to stage a slideshow.`,
    };
  }
  if (classification.reason === "containsAudio") {
    return {
      title: "Mixed selection includes audio",
      body: "Audio belongs on the Master Audio lane. Select images only to stage a slideshow, or select a single asset.",
    };
  }
  return {
    title: "Mixed image and video selection",
    body: "A composite clip must currently contain images only. Select images together, or preview one video at a time.",
  };
}
