/** Lab audio helpers — full-track demucs, then FFmpeg slices from mix or vocals. */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { createAuthedSdk } from "../auth/session";

export type AudioSliceResult = {
  path: string;
  mediaUrl: string;
  mode: "slice" | "vocals";
  note: string;
};

export type AudioTrackResult = {
  path: string;
  mediaUrl: string;
  note: string;
};

function mediaUrlFor(path: string): string {
  return convertFileSrc(path);
}

/** Cached full vocals stem path for this source, if demucs already ran. */
export async function cachedFullVocalsPath(
  sourcePath: string,
): Promise<string | null> {
  return invoke<string | null>("library_cached_full_vocals", {
    sourcePath,
  });
}

/** Demucs on the full mix once (cached under Lab audio cache). */
export async function separateFullVocals(opts: {
  sourcePath: string;
}): Promise<AudioTrackResult> {
  const path = await invoke<string>("library_separate_vocals", {
    sourcePath: opts.sourcePath,
  });
  return {
    path,
    mediaUrl: mediaUrlFor(path),
    note: "Full-track vocals stem (demucs, cached).",
  };
}

export async function sliceAudioRange(opts: {
  sourcePath: string;
  inSec: number;
  outSec: number;
}): Promise<AudioSliceResult> {
  const path = await invoke<string>("library_slice_audio", {
    sourcePath: opts.sourcePath,
    inSec: opts.inSec,
    outSec: opts.outSec,
  });
  return {
    path,
    mediaUrl: mediaUrlFor(path),
    mode: "slice",
    note: "FFmpeg time slice.",
  };
}

/**
 * Product path for a2v: ensure full vocals stem exists, then slice that stem.
 * Lab Vocals / slice UI does the same steps visibly.
 */
export async function isolateVocalsRange(opts: {
  sourcePath: string;
  inSec: number;
  outSec: number;
}): Promise<AudioSliceResult> {
  const full = await separateFullVocals({ sourcePath: opts.sourcePath });
  const slice = await sliceAudioRange({
    sourcePath: full.path,
    inSec: opts.inSec,
    outSec: opts.outSec,
  });
  return {
    ...slice,
    mode: "vocals",
    note: "Sliced from full-track vocals stem.",
  };
}

/**
 * Upload a local vocals slice as a reusable Parascene audio clip so the a2v
 * provider can fetch it via a public share URL. Returns the clip id (used as
 * `audio_clip_id` in create args) plus the resolved public URL.
 */
export async function uploadVocalsSliceClip(
  path: string,
  opts?: { title?: string; durationSec?: number },
): Promise<{ clipId: string; audioUrl: string | null }> {
  const bytesBase64 = await invoke<string>("library_read_file_base64", { path });
  const sdk = createAuthedSdk();
  const { id, audioUrl } = await sdk.recordAudioClip({
    bytesBase64,
    contentType: "audio/wav",
    title: opts?.title ?? "Lab vocals slice",
    durationSec: opts?.durationSec,
    sourceType: "recorded",
  });
  return { clipId: id, audioUrl };
}

/** Remove a previously uploaded audio clip (manual cleanup). */
export async function deleteAudioClip(clipId: string): Promise<void> {
  const sdk = createAuthedSdk();
  await sdk.deleteAudioClip(clipId);
}

export type WaveformPeaks = {
  peaks: number[];
  durationSec: number;
};

export async function audioWaveformPeaks(
  path: string,
  buckets = 128,
): Promise<WaveformPeaks> {
  return invoke<WaveformPeaks>("library_audio_waveform_peaks", { path, buckets });
}

export type ExtendMode = "loop" | "pingPong" | "trimLoop";

export async function bakeClipExtend(opts: {
  sourcePath: string;
  mode: ExtendMode;
  targetSec: number;
  inSec?: number;
  outSec?: number;
}): Promise<{ path: string; mediaUrl: string }> {
  const path = await invoke<string>("library_extend_clip", {
    sourcePath: opts.sourcePath,
    mode: opts.mode,
    targetSec: opts.targetSec,
    inSec: opts.inSec ?? null,
    outSec: opts.outSec ?? null,
  });
  return { path, mediaUrl: mediaUrlFor(path) };
}
