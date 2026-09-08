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

/** Mix for a generate slice. Must not write/prune the monitor `timeline-audio/` bake. */
export async function bakeGenerateTimelineAudio(
  projectId: string,
  clips: readonly TimelineClip[],
): Promise<TimelineAudioBakeResult> {
  const input = timelineClipsToRenderInput(clips);
  await ensureRenderMediaLocal(input);
  return invoke<TimelineAudioBakeResult>("library_bake_timeline_audio", {
    projectId,
    clips: input,
    purpose: "generate",
  });
}

export async function deleteTimelineAudioBake(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  await invoke("library_delete_timeline_audio_bake", { path: trimmed });
}
