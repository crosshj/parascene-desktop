import { invoke } from "@tauri-apps/api/core";

export async function openHelpWindow(topicId?: string): Promise<void> {
  try {
    await invoke("open_help_window", { topicId: topicId ?? null });
  } catch {
    // Browser tests and non-Tauri shells have no native Help window.
  }
}
