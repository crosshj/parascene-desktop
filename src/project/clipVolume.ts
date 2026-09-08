/** Per-instance gain on a timeline audio clip. Independent of monitor master. */

export const DEFAULT_CLIP_VOLUME = 100;

export function clipVolumePercent(clip?: {
  volume?: number | null;
} | null): number {
  const n = Number(clip?.volume);
  if (!Number.isFinite(n)) return DEFAULT_CLIP_VOLUME;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Linear gain 0–1 for HTML media / ffmpeg `volume=`. */
export function clipVolumeGain(clip?: {
  volume?: number | null;
} | null): number {
  return clipVolumePercent(clip) / 100;
}

export function clipVolumeIsUnity(clip?: {
  volume?: number | null;
} | null): boolean {
  return clipVolumePercent(clip) === DEFAULT_CLIP_VOLUME;
}

/** Persist only non-unity volumes. Omitted / 100 = unity. */
export function persistClipVolume(clip?: {
  volume?: number | null;
} | null): number | undefined {
  const v = clipVolumePercent(clip);
  return v === DEFAULT_CLIP_VOLUME ? undefined : v;
}

/** Master (0–100) times instance gain, clamped for HTMLMediaElement.volume. */
export function monitorElementVolume(
  masterPercent: number,
  clip?: { volume?: number | null } | null,
): number {
  const master = Number(masterPercent);
  const masterGain = Number.isFinite(master)
    ? Math.max(0, Math.min(1, master / 100))
    : 1;
  return Math.max(0, Math.min(1, masterGain * clipVolumeGain(clip)));
}
