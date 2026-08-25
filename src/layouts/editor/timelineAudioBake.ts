import { invoke } from "@tauri-apps/api/core";
import type { TimelineClip } from "../../project/types";
import {
  ensureRenderMediaLocal,
  timelineClipsToRenderInput,
} from "../../publisher/renderClient";

export type TimelineAudioBakeResult = {
  path: string;
  durationSec: number;
};

export async function bakeTimelineAudio(
  projectId: string,
  clips: readonly TimelineClip[],
): Promise<TimelineAudioBakeResult> {
  const input = timelineClipsToRenderInput(clips);
  await ensureRenderMediaLocal(input);
  return invoke<TimelineAudioBakeResult>("library_bake_timeline_audio", {
    projectId,
    clips: input,
  });
}

export async function deleteTimelineAudioBake(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  await invoke("library_delete_timeline_audio_bake", { path: trimmed });
}
