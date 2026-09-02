import type { Creation } from "./types";

const CDN_OBJECT_ID_RE = /^o_[a-f0-9]{24}$/i;
const PARASCENE_AUDIO_PATH_RE = /\/api\/create\/images\/\d+\/audio(?:\b|$)/i;

function cdnIdFromRemoteJson(remoteJson: string | null | undefined): string | null {
  const raw = remoteJson?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      meta?: { audio?: { cdn_id?: unknown } };
      audio?: { cdn_id?: unknown };
    };
    const fromMeta = parsed?.meta?.audio?.cdn_id;
    const fromRoot = parsed?.audio?.cdn_id;
    const id =
      typeof fromMeta === "string"
        ? fromMeta.trim()
        : typeof fromRoot === "string"
          ? fromRoot.trim()
          : "";
    return CDN_OBJECT_ID_RE.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Product create: Parascene resolves this to a Blue CDN URL. Do not mint here.
 * Used by A2V and Parascene MiniMax H3 when timeline audio is a CDN Creation.
 */
export function attachAudioCreationRangeArgs(
  args: Record<string, unknown>,
  opts: { creationId: number; startSec: number; durationSec: number },
): void {
  args.audio_creation_id = opts.creationId;
  args.audio_start_sec = opts.startSec;
  args.audio_duration_sec = opts.durationSec;
}

/**
 * True when product A2V can send `audio_creation_id` + window instead of
 * uploading a throwaway `/api/audio-clips` slice (CDN-backed audio Creation).
 */
export function creationSupportsCdnAudioWindow(
  c: Pick<Creation, "id" | "mediaType" | "remoteUrl" | "remoteJson"> | null | undefined,
): boolean {
  if (!c) return false;
  const id = Number(String(c.id ?? "").trim());
  if (!Number.isFinite(id) || id <= 0) return false;
  const kind = String(c.mediaType ?? "")
    .trim()
    .toLowerCase();
  if (kind && kind !== "audio") return false;
  if (cdnIdFromRemoteJson(c.remoteJson)) return true;
  return PARASCENE_AUDIO_PATH_RE.test(c.remoteUrl?.trim() ?? "");
}
