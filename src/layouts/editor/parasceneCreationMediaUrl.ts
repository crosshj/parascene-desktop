import type { Creation } from "../../library/types";

const CREATED_MEDIA_RE = /\/api\/(?:images|videos)\/created\//i;
const CREATED_VIDEO_RE = /\/api\/videos\/created\//i;
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif|bmp)(?:\?|$)/i;

function remoteJsonMediaUrl(remoteJson: string | null | undefined): {
  url: string | null;
  videoUrl: string | null;
} {
  if (!remoteJson?.trim()) return { url: null, videoUrl: null };
  try {
    const raw = JSON.parse(remoteJson) as { url?: string; video_url?: string };
    return {
      url: raw.url?.trim() || null,
      videoUrl: raw.video_url?.trim() || null,
    };
  } catch {
    return { url: null, videoUrl: null };
  }
}

export function isHttpMediaUrl(url: string | null | undefined): boolean {
  const raw = url?.trim() ?? "";
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  if (/^asset:\/\//i.test(raw) || /localhost|127\.0\.0\.1/i.test(raw)) return false;
  return true;
}

export function looksLikeImageFileUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw) return false;
  if (CREATED_VIDEO_RE.test(raw)) return false;
  return IMAGE_FILE_RE.test(raw);
}

/** Stamp `creation_id` so Parascene create can mint a provider share URL. */
export function withParasceneCreationId(
  url: string,
  creationId: string,
): string {
  const id = creationId.trim();
  if (!id || !/^\d+$/.test(id)) return url;
  if (!CREATED_MEDIA_RE.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("creation_id") === id) return url;
    parsed.searchParams.set("creation_id", id);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Hosted video Creation URL for `input_video_urls`.
 * Parascene create rewrites unpublished `/api/videos/created/…` to a share
 * `/video` link so Blue can GET it without a user session.
 */
export function resolveParasceneVideoRefUrl(
  row: Pick<Creation, "id" | "remoteUrl" | "videoUrl" | "remoteJson">,
): string {
  const fromJson = remoteJsonMediaUrl(row.remoteJson);
  const candidates = [
    row.videoUrl?.trim() || null,
    fromJson.videoUrl,
    row.remoteUrl?.trim() || null,
    fromJson.url,
  ];
  for (const url of candidates) {
    if (!url || looksLikeImageFileUrl(url) || !isHttpMediaUrl(url)) continue;
    return withParasceneCreationId(url, String(row.id ?? "").trim());
  }
  throw new Error(
    `Asset ${row.id} has no Parascene video URL — sync it first.`,
  );
}
