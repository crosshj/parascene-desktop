import {
  isGenerateIntentId,
  makeAddAssetIntent,
  normalizeGenerateServer,
  resolveAddAssetIntent,
  resolveDestination,
  type AddAssetIntent,
  type GenerateDestination,
} from "./previewIntent";

export const GENERATE_INTENT_PREFS_KEY = "parascene.generateIntent.v1";

const DEFAULT_INTENT = makeAddAssetIntent("image_to_video", "parascene_blue");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGenerateDestination(value: unknown): value is GenerateDestination {
  return value === "assets" || value === "timeline";
}

/** Last Generate path (intent → server), app-global across projects. */
export function loadLastGenerateIntent(): AddAssetIntent {
  try {
    const raw = localStorage.getItem(GENERATE_INTENT_PREFS_KEY);
    if (!raw) return { ...DEFAULT_INTENT };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { ...DEFAULT_INTENT };

    const intentId = isGenerateIntentId(parsed.intentId)
      ? parsed.intentId
      : null;
    const server = normalizeGenerateServer(parsed.server);
    if (!intentId || !server) return { ...DEFAULT_INTENT };

    const destination = isGenerateDestination(parsed.destination)
      ? parsed.destination
      : undefined;
    return (
      resolveAddAssetIntent(
        makeAddAssetIntent(intentId, server, destination),
      ) ?? { ...DEFAULT_INTENT }
    );
  } catch {
    return { ...DEFAULT_INTENT };
  }
}

export function saveLastGenerateIntent(intent: AddAssetIntent): void {
  const resolved = resolveAddAssetIntent(intent);
  if (!resolved) return;
  try {
    localStorage.setItem(
      GENERATE_INTENT_PREFS_KEY,
      JSON.stringify({
        intentId: resolved.intentId,
        server: resolved.server,
        destination: resolveDestination(resolved),
      }),
    );
  } catch {
    // ignore quota / private mode
  }
}
