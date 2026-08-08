/** Pre-render intent catalog for empty-clip (+) and multi-select preview panes. */

export type IntentPlacement = "timeline" | "none";

/** Stable id `parascene_blue` (legacy); UI label is "Parascene". */
export type AddAssetProviderId = "parascene_blue" | "replicate";

export type AddAssetMethodId =
  | "blue_timeline_fill"
  | "blue_text_to_video"
  | "replicate_timeline_fill"
  | "replicate_text_to_image"
  | "replicate_image_to_image";

export type SelectionIntentModeId =
  | "slideshow"
  | "generate_from_selection"
  | "composite";

export type AddAssetIntent = {
  provider: AddAssetProviderId;
  methodId: AddAssetMethodId;
};

export type AddAssetProviderDef = {
  id: AddAssetProviderId;
  label: string;
  description: string;
};

export type AddAssetMethodDef = {
  id: AddAssetMethodId;
  provider: AddAssetProviderId;
  label: string;
  description: string;
  placement: IntentPlacement;
  /** Wired end-to-end in this ship; stubs show “Coming soon”. */
  wired: boolean;
};

export type SelectionIntentModeDef = {
  id: SelectionIntentModeId;
  label: string;
  description: string;
  placement: IntentPlacement;
  wired: boolean;
};

export const ADD_ASSET_PROVIDERS: readonly AddAssetProviderDef[] = [
  {
    id: "parascene_blue",
    label: "Parascene",
    description: "Audio- and frame-driven video generation on the timeline.",
  },
  {
    id: "replicate",
    label: "Replicate",
    description: "Image and video models hosted on Replicate.",
  },
] as const;

export const ADD_ASSET_METHODS: readonly AddAssetMethodDef[] = [
  {
    id: "blue_timeline_fill",
    provider: "parascene_blue",
    label: "Timeline video fill",
    description:
      "Place a blank clip on the timeline, then generate with start-frame or first+last continuity.",
    placement: "timeline",
    wired: true,
  },
  {
    id: "blue_text_to_video",
    provider: "parascene_blue",
    label: "Text → video",
    description: "Generate a video from a text prompt.",
    placement: "none",
    wired: false,
  },
  {
    id: "replicate_timeline_fill",
    provider: "replicate",
    label: "Timeline video fill",
    description:
      "Place a blank clip, then generate with gap bridge, continue, or motion match on enabled Replicate models.",
    placement: "timeline",
    wired: true,
  },
  {
    id: "replicate_text_to_image",
    provider: "replicate",
    label: "Text → image",
    description: "Generate a still from a text prompt.",
    placement: "none",
    wired: true,
  },
  {
    id: "replicate_image_to_image",
    provider: "replicate",
    label: "Image → image",
    description: "Mutate or restyle an existing still.",
    placement: "none",
    wired: false,
  },
] as const;

export const SELECTION_INTENT_MODES: readonly SelectionIntentModeDef[] = [
  {
    id: "slideshow",
    label: "Slideshow",
    description:
      "Arrange the selected images into a timed slideshow and place it on the timeline.",
    placement: "timeline",
    wired: true,
  },
  {
    id: "generate_from_selection",
    label: "Generate from selection",
    description: "Use the picked images with Parascene or Replicate.",
    placement: "none",
    wired: true,
  },
  {
    id: "composite",
    label: "Composite",
    description: "Create a composition in Assets, then iterate plate and AI edits inside it.",
    placement: "none",
    wired: true,
  },
] as const;

export function addAssetMethodsForProvider(
  provider: AddAssetProviderId,
): AddAssetMethodDef[] {
  return ADD_ASSET_METHODS.filter((m) => m.provider === provider);
}

export function findAddAssetMethod(
  methodId: AddAssetMethodId | null | undefined,
): AddAssetMethodDef | null {
  if (!methodId) return null;
  return ADD_ASSET_METHODS.find((m) => m.id === methodId) ?? null;
}

export function findSelectionIntentMode(
  modeId: SelectionIntentModeId | null | undefined,
): SelectionIntentModeDef | null {
  if (!modeId) return null;
  return SELECTION_INTENT_MODES.find((m) => m.id === modeId) ?? null;
}

export function addAssetIntentAllowsTimelinePlacement(
  intent: AddAssetIntent | null | undefined,
): boolean {
  const method = findAddAssetMethod(intent?.methodId);
  return Boolean(method?.wired && method.placement === "timeline");
}

/** Wired library-only methods (e.g. Replicate text → image) — no Place/Drag. */
export function addAssetIntentAllowsLibraryGeneration(
  intent: AddAssetIntent | null | undefined,
): boolean {
  const method = findAddAssetMethod(intent?.methodId);
  return Boolean(
    method?.wired &&
      method.placement === "none" &&
      method.id === "replicate_text_to_image",
  );
}

export function selectionModeAllowsTimelinePlacement(
  modeId: SelectionIntentModeId | null | undefined,
): boolean {
  const mode = findSelectionIntentMode(modeId);
  return Boolean(mode?.wired && mode.placement === "timeline");
}

export function isAddAssetProviderId(value: unknown): value is AddAssetProviderId {
  return value === "parascene_blue" || value === "replicate";
}

export function isAddAssetMethodId(value: unknown): value is AddAssetMethodId {
  return ADD_ASSET_METHODS.some((m) => m.id === value);
}
