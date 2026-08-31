/** Lab audio helpers — full-track demucs, then FFmpeg slices from mix or vocals. */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  deleteAudioClipViaService,
  recordAudioClipViaService,
  uploadGenericImageViaService,
} from "../services/parasceneCatalog";

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
  // Lab slices / stems / extends are A/V — use Range-capable `media` scheme.
  return convertFileSrc(path, "media");
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
  const { id, audioUrl } = await recordAudioClipViaService({
    path,
    contentType: "audio/wav",
    title: opts?.title ?? "Lab vocals slice",
    durationSec: opts?.durationSec,
    sourceType: "recorded",
  });
  return { clipId: id, audioUrl };
}

/** Remove a previously uploaded audio clip (manual cleanup). */
export async function deleteAudioClip(clipId: string): Promise<void> {
  await deleteAudioClipViaService(clipId);
}

export type WaveformPeaks = {
  peaks: number[];
  durationSec: number;
  /** Peak bucket max before per-file normalization (for shared-scale overlays). */
  amplitudeMax: number;
};

export async function audioWaveformPeaks(
  path: string,
  buckets = 128,
): Promise<WaveformPeaks> {
  return invoke<WaveformPeaks>("library_audio_waveform_peaks", { path, buckets });
}

export async function bakeClipExtend(opts: {
  sourcePath: string;
  pingPong: boolean;
  targetSec: number;
  inSec?: number;
  outSec?: number;
  speed?: number;
}): Promise<{ path: string; mediaUrl: string }> {
  const path = await invoke<string>("library_extend_clip", {
    sourcePath: opts.sourcePath,
    pingPong: opts.pingPong,
    targetSec: opts.targetSec,
    inSec: opts.inSec ?? null,
    outSec: opts.outSec ?? null,
    speed: opts.speed ?? null,
  });
  return { path, mediaUrl: mediaUrlFor(path) };
}

/** Remove a superseded extend bake from the lab cache. */
export async function deleteExtendCacheFile(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;
  await invoke("library_delete_extend_cache_file", { path: trimmed });
}

/** Pull the last readable frame from a local video (Rust decodes to EOF). */
export async function extractVideoLastFrame(
  sourcePath: string,
): Promise<{ path: string; mediaUrl: string; timeSec: number }> {
  return extractVideoFrame({ sourcePath, timeSec: 1e9 });
}

/** Full-resolution JPEG still from a local video at `timeSec` (Lab → Pull frame). */
export async function extractVideoFrame(opts: {
  sourcePath: string;
  timeSec: number;
}): Promise<{ path: string; mediaUrl: string; timeSec: number }> {
  const path = await invoke<string>("library_extract_video_frame", {
    sourcePath: opts.sourcePath,
    timeSec: opts.timeSec,
  });
  return { path, mediaUrl: mediaUrlFor(path), timeSec: opts.timeSec };
}

/** Fit/Fill/Stretch a local still into the project aspect (cached JPEG). */
export async function applyImageFraming(opts: {
  sourcePath: string;
  framing: "fit" | "fill" | "stretch" | string;
  aspectRatio: string;
}): Promise<{ path: string; mediaUrl: string }> {
  const path = await invoke<string>("library_apply_image_framing", {
    sourcePath: opts.sourcePath,
    framing: opts.framing,
    aspectRatio: opts.aspectRatio,
  });
  return { path, mediaUrl: mediaUrlFor(path) };
}

/** Upload a local image file to Parascene generic storage; returns a public URL. */
export async function uploadLocalImageFile(
  path: string,
  opts?: { filename?: string; contentType?: string },
): Promise<{ url: string; key?: string }> {
  return uploadGenericImageViaService({
    path,
    contentType: opts?.contentType ?? "image/jpeg",
    filename: opts?.filename ?? "lab-frame.jpg",
  });
}
