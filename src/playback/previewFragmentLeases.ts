import { invoke } from "@tauri-apps/api/core";

/** Hold disk paths against prune/clear while MSE fetches them (F7). */
export async function acquirePreviewLeases(
  paths: readonly string[],
): Promise<void> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) return;
  try {
    await invoke("library_preview_lease_acquire", { paths: unique });
  } catch {
    // Non-Tauri tests — best effort.
  }
}

export async function releasePreviewLeases(
  paths: readonly string[],
): Promise<void> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) return;
  try {
    await invoke("library_preview_lease_release", { paths: unique });
  } catch {
    // Non-Tauri tests — best effort.
  }
}
