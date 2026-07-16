import { convertFileSrc } from "@tauri-apps/api/core";
import { ensureProxy, type ProxyMedia } from "./catalogClient";

const inflight = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

function toUrl(media: ProxyMedia): string {
  return convertFileSrc(media.path);
}

/** Sync peek at a previously resolved proxy asset-protocol URL. */
export function getCachedProxyUrl(assetId: string): string | null {
  return resolved.get(assetId.trim()) ?? null;
}

/** Asset-protocol URL for a cached normalized preview proxy. */
export async function ensureProxyMediaUrl(assetId: string): Promise<string> {
  const id = assetId.trim();
  if (!id) throw new Error("Missing asset id for proxy");

  const cached = resolved.get(id);
  if (cached) return cached;

  let pending = inflight.get(id);
  if (!pending) {
    pending = ensureProxy(id)
      .then((media) => {
        const url = toUrl(media);
        resolved.set(id, url);
        inflight.delete(id);
        return url;
      })
      .catch((err) => {
        inflight.delete(id);
        throw err;
      });
    inflight.set(id, pending);
  }
  return pending;
}
