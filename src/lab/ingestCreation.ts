/** Ingest a completed remote creation into local Library + optional project. */

import { applyManifest } from "../library/catalogClient";
import { mapRemoteCreation } from "../sync/manifestSync";
import type { RemoteCreateImage } from "../sdk/parascene";
import { absolutizeAssetUrl } from "../sdk/parascene";
import { getEnvConfig } from "../auth/session";

export async function ingestRemoteCreation(
  row: RemoteCreateImage,
): Promise<string> {
  const origin = getEnvConfig().baseUrl;
  const absolutized: RemoteCreateImage = {
    ...row,
    url: absolutizeAssetUrl(row.url ?? undefined, origin) ?? row.url,
    thumbnail_url:
      absolutizeAssetUrl(row.thumbnail_url ?? undefined, origin) ??
      row.thumbnail_url,
    fit_thumbnail_url:
      absolutizeAssetUrl(row.fit_thumbnail_url ?? undefined, origin) ??
      row.fit_thumbnail_url,
    video_url:
      absolutizeAssetUrl(row.video_url ?? undefined, origin) ?? row.video_url,
    audio_url:
      absolutizeAssetUrl(row.audio_url ?? undefined, origin) ?? row.audio_url,
  };
  const upsert = mapRemoteCreation(absolutized);
  await applyManifest([upsert]);
  return String(row.id);
}

export function newCreationToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `lab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
