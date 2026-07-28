/** Pre-render intent catalog for empty-clip (+) and multi-select preview panes. */

export type IntentPlacement = "timeline" | "none";

export type AddAssetProviderId = "parascene_blue" | "replicate" | "parascene";

export type AddAssetMethodId =
  | "blue_timeline_fill"
  | "blue_text_to_video"
  | "replicate_timeline_fill"
  | "replicate_text_to_image"
  | "replicate_image_to_image"
  | "parascene_placeholder";

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
    label: "Parascene Blue",
    description: "Audio- and frame-driven video generation on the timeline.",
  },
  {
    id: "replicate",
    label: "Replicate",
    description: "Image and video models hosted on Replicate.",
  },
  {
    id: "parascene",
    label: "Parascene",
    description: "Parascene generation paths (coming soon).",
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
    wired: false,
  },
  {
    id: "replicate_image_to_image",
    provider: "replicate",
    label: "Image → image",
    description: "Mutate or restyle an existing still.",
    placement: "none",
    wired: false,
  },
  {
    id: "parascene_placeholder",
    provider: "parascene",
    label: "Parascene generate",
    description: "Parascene creation methods will appear here.",
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
    description:
      "Use the picked images with Parascene Blue, Replicate, or Parascene.",
    placement: "none",
    wired: true,
  },
  {
    id: "composite",
    label: "Composite",
    description: "Combine the selection into a single composite frame or clip.",
    placement: "none",
    wired: false,
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

export function selectionModeAllowsTimelinePlacement(
  modeId: SelectionIntentModeId | null | undefined,
): boolean {
  const mode = findSelectionIntentMode(modeId);
  return Boolean(mode?.wired && mode.placement === "timeline");
}

export function isAddAssetProviderId(value: unknown): value is AddAssetProviderId {
  return (
    value === "parascene_blue" ||
    value === "replicate" ||
    value === "parascene"
  );
}

export function isAddAssetMethodId(value: unknown): value is AddAssetMethodId {
  return ADD_ASSET_METHODS.some((m) => m.id === value);
}
