/** User audio lanes: A1 (Master) and optional A2. */

export type AudioTrackIndex = 1 | 2;

export function clipAudioTrack(clip: {
  audioTrack?: number | null;
  linkedVideoClipId?: string | null;
}): AudioTrackIndex {
  if (clip.linkedVideoClipId?.trim()) return 1;
  return clip.audioTrack === 2 ? 2 : 1;
}

/** Persist only A2; omitted / 1 means Master Audio. */
export function persistAudioTrack(clip: {
  audioTrack?: number | null;
  linkedVideoClipId?: string | null;
}): 2 | undefined {
  return clipAudioTrack(clip) === 2 ? 2 : undefined;
}

export function normalizeAudioTrack(value: unknown): 2 | undefined {
  return Number(value) === 2 ? 2 : undefined;
}

export function clipsOnAudioTrack<
  T extends {
    lane?: "video" | "audio";
    audioTrack?: number | null;
    linkedVideoClipId?: string | null;
  },
>(clips: readonly T[], track: AudioTrackIndex): T[] {
  return clips.filter((c) => c.lane === "audio" && clipAudioTrack(c) === track);
}
