/**
 * The preview transport slider is reused for three different jobs.
 * Do not treat an Assets-panel listen as a timeline instance volume.
 */

export type PreviewVolumeRole = "monitor" | "clip_instance" | "source_listen";

export function isTimelineAudioInstance(clip: {
  kind?: string | null;
  lane?: string | null;
} | null): boolean {
  if (!clip) return false;
  return clip.kind === "audio" || clip.lane === "audio";
}

export function previewVolumeRole(opts: {
  monitorMode: "source" | "timeline";
  /** True when the preview is bound to a selected timeline clip. */
  editingClip: boolean;
  clip?: { kind?: string | null; lane?: string | null } | null;
}): PreviewVolumeRole {
  if (opts.monitorMode === "timeline") return "monitor";
  if (opts.editingClip && isTimelineAudioInstance(opts.clip ?? null)) {
    return "clip_instance";
  }
  return "source_listen";
}

export function previewVolumeLabel(role: PreviewVolumeRole): string {
  if (role === "clip_instance") return "Clip volume";
  if (role === "monitor") return "Volume";
  return "Volume";
}

export function previewVolumeTitle(role: PreviewVolumeRole): string | undefined {
  if (role === "clip_instance") return "This timeline clip’s volume";
  return undefined;
}
