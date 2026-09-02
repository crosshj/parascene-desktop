/**
 * Resolve a project asset to a local file (Blue / Replicate) or confirm it exists.
 */

import { ensureLocal, getCreations } from "../../library/catalogClient";

export async function resolveLocalMediaPath(
  assetId: string,
  opts?: { label?: string },
): Promise<string> {
  const id = assetId.trim();
  if (!id) throw new Error("Missing media asset.");
  await ensureLocal([id], { fullMedia: true, urgent: true });
  const [row] = await getCreations([id]);
  const path = row?.localPath?.trim();
  if (!path) {
    const label = opts?.label ?? "media";
    throw new Error(
      `Could not load a local file for ${label}. Download it first, then try again.`,
    );
  }
  return path;
}

export async function resolveLocalMediaPaths(
  assetIds: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of assetIds) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    out.push(await resolveLocalMediaPath(trimmed));
  }
  return out;
}
