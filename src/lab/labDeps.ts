/** Local FFmpeg / Demucs readiness for Lab gates and Settings. */

import { invoke } from "@tauri-apps/api/core";

export type LabToolStatus = {
  id: string;
  label: string;
  ready: boolean;
  path: string | null;
  detail: string;
  installHint: string;
};

export type LabDepsStatus = {
  ffmpeg: LabToolStatus;
  demucs: LabToolStatus;
  docPath: string | null;
};

export const LAB_DEPS_CHANGED_EVENT = "parascene:lab-deps-changed";

export function notifyLabDepsChanged(): void {
  window.dispatchEvent(new Event(LAB_DEPS_CHANGED_EVENT));
}

export async function getLabDepsStatus(): Promise<LabDepsStatus> {
  return invoke<LabDepsStatus>("library_lab_deps_status");
}

/** pip install --user demucs (may take several minutes; downloads torch). */
export async function installDemucs(): Promise<LabDepsStatus> {
  const status = await invoke<LabDepsStatus>("library_install_demucs");
  notifyLabDepsChanged();
  return status;
}

export async function openLocalToolsDoc(): Promise<void> {
  await invoke<void>("library_open_local_tools_doc");
}
