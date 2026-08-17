/** Intent-first Generate catalog: modality recipe → server → form. */

export type IntentPlacement = "timeline" | "library";

/** Where the generated media should land when the user can choose. */
export type GenerateDestination = "assets" | "timeline";

/**
 * assets_only — stills / audio gen into the project library
 * timeline_only — needs timeline context (e.g. clip audio / neighbors)
 * choose — user picks Assets vs Timeline
 */
export type DestinationPolicy = "assets_only" | "timeline_only" | "choose";

/** Modality recipe shown first in Generate. */
export type GenerateIntentId =
  | "text_to_image"
  | "image_to_image"
  | "text_to_video"
  | "image_to_video"
  | "image_audio_to_video"
  | "video_to_video"
  | "reference_to_video"
  | "text_to_music"
  | "text_to_speech";

/**
 * Backend lane under an intent.
 * Persist `parascene_blue` as the Parascene server id for legacy drafts/jobs.
 */
export type GenerateServerId = "parascene_blue" | "blue_direct" | "replicate";

/** @deprecated Prefer GenerateServerId — kept for call-site migration. */
export type AddAssetProviderId = GenerateServerId;

/**
 * @deprecated Prefer GenerateIntentId. Legacy method ids still parse from drafts.
 */
export type AddAssetMethodId =
  | "blue_timeline_fill"
  | "blue_text_to_video"
  | "blue_direct_timeline_fill"
  | "replicate_timeline_fill"
  | "replicate_text_to_image"
  | "replicate_image_to_image"
  | GenerateIntentId;

export type SelectionIntentModeId =
  | "slideshow"
  | "generate_from_selection"
  | "composite";

/** Chosen Generate path: intent first, server second. */
export type AddAssetIntent = {
  intentId: GenerateIntentId;
  server: GenerateServerId;
  /** Assets folder vs timeline placeholder — set when policy is choose. */
  destination?: GenerateDestination;
  /** @deprecated Alias of server for older call sites. */
  provider?: GenerateServerId;
  /** @deprecated Prefer intentId. */
  methodId?: AddAssetMethodId;
};

export type IntentServerStatus = "wired" | "coming_soon";

export type GenerateIntentDef = {
  id: GenerateIntentId;
  label: string;
  /** Short card subtitle — keep one line. */
  description: string;
  placement: IntentPlacement;
  destinationPolicy: DestinationPolicy;
  /** Media slots the shared form shell should expose. */
  mediaSlots: readonly (
    | "prompt"
    | "image"
    | "image_pair"
    | "audio"
    | "video"
    | "references"
  )[];
};

export type GenerateServerDef = {
  id: GenerateServerId;
  label: string;
  description: string;
};

export type IntentServerCapability = {
  intentId: GenerateIntentId;
  server: GenerateServerId;
  status: IntentServerStatus;
};

export type SelectionIntentModeDef = {
  id: SelectionIntentModeId;
  label: string;
  description: string;
  placement: "timeline" | "none";
  wired: boolean;
};

export const GENERATE_INTENTS: readonly GenerateIntentDef[] = [
  {
    id: "text_to_image",
    label: "Text to Image",
    description: "Prompt → still",
    placement: "library",
    destinationPolicy: "choose",
    mediaSlots: ["prompt"],
  },
  {
    id: "image_to_image",
    label: "Image to Image",
    description: "Still → still",
    placement: "library",
    destinationPolicy: "choose",
    mediaSlots: ["prompt", "image"],
  },
  {
    id: "text_to_video",
    label: "Text to Video",
    description: "Prompt → video",
    placement: "timeline",
    destinationPolicy: "choose",
    mediaSlots: ["prompt"],
  },
  {
    id: "image_to_video",
    label: "Image to Video",
    description: "Still → video",
    placement: "timeline",
    destinationPolicy: "choose",
    mediaSlots: ["prompt", "image", "image_pair"],
  },
  {
    id: "image_audio_to_video",
    label: "Audio to Video",
    description: "Audio → video",
    placement: "timeline",
    destinationPolicy: "timeline_only",
    mediaSlots: ["prompt", "image", "audio"],
  },
  {
    id: "video_to_video",
    label: "Video to Video",
    description: "Video → video",
    placement: "timeline",
    destinationPolicy: "choose",
    mediaSlots: ["prompt", "video", "image"],
  },
  {
    id: "reference_to_video",
    label: "Refs to Video",
    description: "Refs → video",
    placement: "timeline",
    destinationPolicy: "choose",
    mediaSlots: ["prompt", "references"],
  },
  {
    id: "text_to_music",
    label: "Text to Music",
    description: "Prompt → music",
    placement: "library",
    destinationPolicy: "assets_only",
    mediaSlots: ["prompt"],
  },
  {
    id: "text_to_speech",
    label: "Text to Speech",
    description: "Prompt → voice",
    placement: "library",
    destinationPolicy: "assets_only",
    mediaSlots: ["prompt"],
  },
] as const;

export const GENERATE_SERVERS: readonly GenerateServerDef[] = [
  {
    id: "parascene_blue",
    label: "Parascene",
    description: "Credits · Creations",
  },
  {
    id: "blue_direct",
    label: "Direct to Blue",
    description: "BYO Blue · local-only",
  },
  {
    id: "replicate",
    label: "Replicate",
    description: "BYO token · local-only",
  },
] as const;

/** Intent × server matrix for this ship. */
export const INTENT_SERVER_CAPABILITIES: readonly IntentServerCapability[] = [
  { intentId: "text_to_image", server: "parascene_blue", status: "coming_soon" },
  { intentId: "text_to_image", server: "blue_direct", status: "wired" },
  { intentId: "text_to_image", server: "replicate", status: "wired" },

  { intentId: "image_to_image", server: "parascene_blue", status: "coming_soon" },
  { intentId: "image_to_image", server: "blue_direct", status: "coming_soon" },
  { intentId: "image_to_image", server: "replicate", status: "coming_soon" },

  { intentId: "text_to_video", server: "parascene_blue", status: "wired" },
  { intentId: "text_to_video", server: "blue_direct", status: "wired" },
  { intentId: "text_to_video", server: "replicate", status: "wired" },

  { intentId: "image_to_video", server: "parascene_blue", status: "wired" },
  { intentId: "image_to_video", server: "blue_direct", status: "wired" },
  { intentId: "image_to_video", server: "replicate", status: "wired" },

  {
    intentId: "image_audio_to_video",
    server: "parascene_blue",
    status: "wired",
  },
  { intentId: "image_audio_to_video", server: "blue_direct", status: "wired" },
  {
    intentId: "image_audio_to_video",
    server: "replicate",
    status: "coming_soon",
  },

  { intentId: "video_to_video", server: "parascene_blue", status: "coming_soon" },
  { intentId: "video_to_video", server: "blue_direct", status: "coming_soon" },
  { intentId: "video_to_video", server: "replicate", status: "coming_soon" },

  {
    intentId: "reference_to_video",
    server: "parascene_blue",
    status: "coming_soon",
  },
  {
    intentId: "reference_to_video",
    server: "blue_direct",
    status: "coming_soon",
  },
  {
    intentId: "reference_to_video",
    server: "replicate",
    status: "coming_soon",
  },

  { intentId: "text_to_music", server: "parascene_blue", status: "coming_soon" },
  { intentId: "text_to_music", server: "blue_direct", status: "coming_soon" },
  { intentId: "text_to_music", server: "replicate", status: "coming_soon" },

  { intentId: "text_to_speech", server: "parascene_blue", status: "coming_soon" },
  { intentId: "text_to_speech", server: "blue_direct", status: "coming_soon" },
  { intentId: "text_to_speech", server: "replicate", status: "coming_soon" },
] as const;

/** @deprecated Use GENERATE_SERVERS. */
export const ADD_ASSET_PROVIDERS = GENERATE_SERVERS;

/**
 * @deprecated Flat method list derived from intents for older tests/call sites.
 * Prefer GENERATE_INTENTS + INTENT_SERVER_CAPABILITIES.
 */
export const ADD_ASSET_METHODS = GENERATE_INTENTS.map((intent) => ({
  id: intent.id as AddAssetMethodId,
  provider: "parascene_blue" as GenerateServerId,
  label: intent.label,
  description: intent.description,
  placement: (intent.placement === "timeline" ? "timeline" : "none") as
    | "timeline"
    | "none",
  wired: INTENT_SERVER_CAPABILITIES.some(
    (c) => c.intentId === intent.id && c.status === "wired",
  ),
}));

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
    description: "Use the picked images with an intent and server.",
    placement: "none",
    wired: true,
  },
  {
    id: "composite",
    label: "Composite",
    description:
      "Create a composition in Assets, then iterate plate and AI edits inside it.",
    placement: "none",
    wired: true,
  },
] as const;

export function findGenerateIntent(
  intentId: GenerateIntentId | null | undefined,
): GenerateIntentDef | null {
  if (!intentId) return null;
  return GENERATE_INTENTS.find((i) => i.id === intentId) ?? null;
}

export function findGenerateServer(
  server: GenerateServerId | null | undefined,
): GenerateServerDef | null {
  if (!server) return null;
  return GENERATE_SERVERS.find((s) => s.id === server) ?? null;
}

export function intentServerCapability(
  intentId: GenerateIntentId,
  server: GenerateServerId,
): IntentServerCapability | null {
  return (
    INTENT_SERVER_CAPABILITIES.find(
      (c) => c.intentId === intentId && c.server === server,
    ) ?? null
  );
}

export function serversForIntent(
  intentId: GenerateIntentId,
): IntentServerCapability[] {
  return INTENT_SERVER_CAPABILITIES.filter((c) => c.intentId === intentId);
}

export function isIntentServerWired(
  intentId: GenerateIntentId,
  server: GenerateServerId,
): boolean {
  return intentServerCapability(intentId, server)?.status === "wired";
}

export function defaultDestinationForIntent(
  intentId: GenerateIntentId,
): GenerateDestination {
  const def = findGenerateIntent(intentId);
  if (!def) return "timeline";
  if (def.destinationPolicy === "assets_only") return "assets";
  // Stills prefer Assets until timeline still-generate ships.
  if (
    def.destinationPolicy === "choose" &&
    (intentId === "text_to_image" || intentId === "image_to_image")
  ) {
    return "assets";
  }
  return "timeline";
}

export function resolveDestination(
  intent: AddAssetIntent | null | undefined,
): GenerateDestination {
  if (!intent?.intentId) return "timeline";
  const def = findGenerateIntent(intent.intentId);
  if (!def) return "timeline";
  if (def.destinationPolicy === "assets_only") return "assets";
  if (def.destinationPolicy === "timeline_only") return "timeline";
  if (intent.destination === "assets" || intent.destination === "timeline") {
    return intent.destination;
  }
  return defaultDestinationForIntent(intent.intentId);
}

/** Policy offers an Assets landing (footer Generate / Assets form). */
export function intentOffersAssetsDestination(
  intentId: GenerateIntentId | null | undefined,
): boolean {
  if (!intentId) return false;
  const def = findGenerateIntent(intentId);
  return (
    def?.destinationPolicy === "assets_only" ||
    def?.destinationPolicy === "choose"
  );
}

/** Policy offers a Timeline landing (Place / Drag). */
export function intentOffersTimelineDestination(
  intentId: GenerateIntentId | null | undefined,
): boolean {
  if (!intentId) return false;
  const def = findGenerateIntent(intentId);
  return (
    def?.destinationPolicy === "timeline_only" ||
    def?.destinationPolicy === "choose"
  );
}

/**
 * Timeline Place/Drag is visible but not wired yet (still-on-timeline generate).
 */
export function intentTimelinePlacementComingSoon(
  intentId: GenerateIntentId | null | undefined,
): boolean {
  return intentId === "text_to_image" || intentId === "image_to_image";
}

export function makeAddAssetIntent(
  intentId: GenerateIntentId,
  server: GenerateServerId,
  destination?: GenerateDestination,
): AddAssetIntent {
  const dest = destination ?? defaultDestinationForIntent(intentId);
  return {
    intentId,
    server,
    destination: dest,
    provider: server,
    methodId: intentId,
  };
}

export function normalizeGenerateServer(
  value: unknown,
): GenerateServerId | null {
  if (value === "parascene" || value === "parascene_blue") return "parascene_blue";
  if (value === "blue_direct" || value === "parascene_blue_direct") {
    return "blue_direct";
  }
  if (value === "replicate") return "replicate";
  return null;
}

export function isGenerateIntentId(value: unknown): value is GenerateIntentId {
  return GENERATE_INTENTS.some((i) => i.id === value);
}

export function isGenerateServerId(value: unknown): value is GenerateServerId {
  return normalizeGenerateServer(value) !== null;
}

/** Map legacy provider+method (+ optional continuity) onto intent+server. */
export function resolveAddAssetIntent(input: {
  intentId?: unknown;
  server?: unknown;
  provider?: unknown;
  methodId?: unknown;
  continuityMode?: unknown;
  audioMode?: unknown;
  destination?: unknown;
}): AddAssetIntent | null {
  const server =
    normalizeGenerateServer(input.server) ??
    normalizeGenerateServer(input.provider);
  const dest =
    input.destination === "assets" || input.destination === "timeline"
      ? input.destination
      : undefined;
  const intentFromField = isGenerateIntentId(input.intentId)
    ? input.intentId
    : null;

  if (intentFromField && server) {
    return makeAddAssetIntent(intentFromField, server, dest);
  }

  const methodId =
    typeof input.methodId === "string" ? input.methodId.trim() : "";

  if (isGenerateIntentId(methodId) && server) {
    return makeAddAssetIntent(methodId, server, dest);
  }

  if (methodId === "replicate_text_to_image") {
    return makeAddAssetIntent("text_to_image", "replicate", dest);
  }
  if (methodId === "replicate_image_to_image") {
    return makeAddAssetIntent("image_to_image", server ?? "replicate", dest);
  }
  if (methodId === "blue_text_to_video") {
    return makeAddAssetIntent(
      "text_to_video",
      server ?? "parascene_blue",
      dest,
    );
  }

  const resolvedServer = server ?? "parascene_blue";

  if (
    methodId === "replicate_timeline_fill" ||
    methodId === "blue_timeline_fill" ||
    methodId === "blue_direct_timeline_fill" ||
    !methodId
  ) {
    if (input.continuityMode === "none") {
      return makeAddAssetIntent("text_to_video", resolvedServer, dest);
    }
    if (
      resolvedServer !== "replicate" &&
      (input.audioMode === "vocals" || input.audioMode === "full_mix")
    ) {
      return makeAddAssetIntent("image_audio_to_video", resolvedServer, dest);
    }
    if (methodId === "replicate_timeline_fill" || resolvedServer === "replicate") {
      return makeAddAssetIntent("image_to_video", "replicate", dest);
    }
    if (resolvedServer === "blue_direct") {
      return makeAddAssetIntent("image_to_video", "blue_direct", dest);
    }
    return makeAddAssetIntent("image_to_video", "parascene_blue", dest);
  }

  if (server) {
    return makeAddAssetIntent("image_to_video", server, dest);
  }
  return null;
}

export function continuityModeForIntent(
  intentId: GenerateIntentId,
  existing?: string | null,
): "none" | "start_frame" | "first_last" | "motion_match" {
  if (intentId === "text_to_video") return "none";
  if (intentId === "image_audio_to_video") return "start_frame";
  if (intentId === "image_to_video") {
    if (existing === "first_last" || existing === "motion_match") {
      return existing;
    }
    return "start_frame";
  }
  return "start_frame";
}

export function audioModeForIntent(
  intentId: GenerateIntentId,
  existing?: string | null,
): "vocals" | "full_mix" | "none" {
  if (intentId === "image_audio_to_video") {
    if (existing === "full_mix" || existing === "vocals") return existing;
    return "vocals";
  }
  return "none";
}

export function addAssetIntentAllowsTimelinePlacement(
  intent: AddAssetIntent | null | undefined,
): boolean {
  const resolved = intent
    ? resolveAddAssetIntent(intent) ?? intent
    : null;
  if (!resolved?.intentId) return false;
  const def = findGenerateIntent(resolved.intentId);
  if (!def) return false;
  if (!isIntentServerWired(resolved.intentId, resolved.server)) return false;
  if (intentTimelinePlacementComingSoon(resolved.intentId)) return false;
  if (!intentOffersTimelineDestination(resolved.intentId)) return false;
  return true;
}

/** Wired library generation into Assets (e.g. Text to Image). */
export function addAssetIntentAllowsLibraryGeneration(
  intent: AddAssetIntent | null | undefined,
): boolean {
  const resolved = intent
    ? resolveAddAssetIntent(intent) ?? intent
    : null;
  if (!resolved?.intentId) return false;
  if (!isIntentServerWired(resolved.intentId, resolved.server)) return false;
  if (!intentOffersAssetsDestination(resolved.intentId)) return false;
  // Only T2I is wired for Assets generate today.
  return resolved.intentId === "text_to_image";
}

export function findSelectionIntentMode(
  modeId: SelectionIntentModeId | null | undefined,
): SelectionIntentModeDef | null {
  if (!modeId) return null;
  return SELECTION_INTENT_MODES.find((m) => m.id === modeId) ?? null;
}

export function selectionModeAllowsTimelinePlacement(
  modeId: SelectionIntentModeId | null | undefined,
): boolean {
  const mode = findSelectionIntentMode(modeId);
  return Boolean(mode?.wired && mode.placement === "timeline");
}

export function isAddAssetProviderId(
  value: unknown,
): value is AddAssetProviderId {
  return normalizeGenerateServer(value) !== null;
}

export function isAddAssetMethodId(value: unknown): value is AddAssetMethodId {
  if (isGenerateIntentId(value)) return true;
  return (
    value === "blue_timeline_fill" ||
    value === "blue_text_to_video" ||
    value === "blue_direct_timeline_fill" ||
    value === "replicate_timeline_fill" ||
    value === "replicate_text_to_image" ||
    value === "replicate_image_to_image"
  );
}

/** @deprecated Prefer serversForIntent / findGenerateIntent. */
export function addAssetMethodsForProvider(
  _provider?: AddAssetProviderId,
): typeof ADD_ASSET_METHODS {
  void _provider;
  return [...ADD_ASSET_METHODS];
}

/** @deprecated Prefer findGenerateIntent. */
export function findAddAssetMethod(
  methodId: AddAssetMethodId | null | undefined,
): (typeof ADD_ASSET_METHODS)[number] | null {
  if (!methodId) return null;
  if (isGenerateIntentId(methodId)) {
    const intent = findGenerateIntent(methodId);
    if (!intent) return null;
    return (
      ADD_ASSET_METHODS.find((m) => m.id === methodId) ?? {
        id: methodId,
        provider: "parascene_blue" as GenerateServerId,
        label: intent.label,
        description: intent.description,
        placement: (intent.placement === "timeline" ? "timeline" : "none") as
          | "timeline"
          | "none",
        wired: INTENT_SERVER_CAPABILITIES.some(
          (c) => c.intentId === methodId && c.status === "wired",
        ),
      }
    );
  }
  return ADD_ASSET_METHODS.find((m) => m.id === methodId) ?? null;
}

export function serverLabel(server: GenerateServerId): string {
  return findGenerateServer(server)?.label ?? server;
}

export function intentLabel(intentId: GenerateIntentId): string {
  return findGenerateIntent(intentId)?.label ?? intentId;
}
