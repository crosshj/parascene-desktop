/**
 * Slice this placeholder’s window from the timeline mix — same path A2V uses.
 * Parascene product (MiniMax H3) must send `audio_clip_id` or `audio_creation_id`,
 * never a generic `/api/images/generic/prompt-audio/…` URL (auth-gated; provider 401).
 */

import { getCreations } from "../../library/catalogClient";
import { isolateVocalsRange, sliceAudioRange, uploadVocalsSliceClip } from "../../lab/audioTools";
import {
  attachAudioCreationRangeArgs,
  creationSupportsCdnAudioWindow,
} from "../../library/cdnAudioCreation";
import type { Creation } from "../../library/types";
import { clipAudioTrack } from "../../project/audioTrack";
import {
  clipVolumeGain,
  clipVolumeIsUnity,
  clipVolumePercent,
} from "../../project/clipVolume";
import type { LyricAlignment, TimelineClip } from "../../project/types";
import {
  resolveAddAssetGenerationTiming,
  resolveAlignmentAudioClip,
} from "./addAssetStartFrame";
import type { TimelineAudioMode } from "./generateMediaRefs";
import { addAssetClipDurationSec } from "./stagedClip";
import { bakeGenerateTimelineAudio } from "./timelineAudioBake";

export type ParasceneProductTimelineAudioKind =
  | "none"
  | "cdn_window"
  | "audio_clip";

/** Generic clip storage URL — MiniMax cannot fetch this (401 without a user session). */
export function isGenericPromptAudioUrl(url: string | null | undefined): boolean {
  return /\/api\/images\/generic\/prompt-audio\//i.test(url?.trim() ?? "");
}

/** Auth-gated Parascene audio paths the provider cannot GET as a stranger. */
export function isProviderFetchableAudioUrl(url: string | null | undefined): boolean {
  const raw = url?.trim() ?? "";
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  if (/^asset:\/\//i.test(raw) || /localhost|127\.0\.0\.1/i.test(raw)) return false;
  if (isGenericPromptAudioUrl(raw)) return false;
  if (/\/api\/create\/images\/\d+\/audio(?:\b|$)/i.test(raw)) return false;
  return true;
}

export function attachParasceneAudioClipId(
  args: Record<string, unknown>,
  clipId: string | number,
): void {
  const n = Number(clipId);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Timeline audio slice uploaded but has no clip id.");
  }
  args.audio_clip_id = n;
  delete args.input_audio_urls;
  delete args.audio_url;
}

export type ParasceneAudioAssetRef =
  | { kind: "url"; url: string }
  | { kind: "clip"; clipId: number };

/**
 * Extra audio refs: public URL if MiniMax can fetch it, otherwise record a
 * library clip from the local file (same as non-CDN timeline audio).
 */
export async function resolveParasceneAudioAssetForCreate(
  creationId: string,
): Promise<ParasceneAudioAssetRef> {
  const id = creationId.trim();
  if (!id) throw new Error("Audio asset is missing.");
  const [row] = await getCreations([id]);
  if (!row) throw new Error(`Asset ${id} not found in Library.`);
  const url = row.remoteUrl?.trim() || row.videoUrl?.trim() || "";
  if (isProviderFetchableAudioUrl(url)) {
    return { kind: "url", url };
  }
  const localPath = row.localPath?.trim();
  if (!localPath) {
    throw new Error(
      `Asset ${id} has no local audio to upload as a Parascene clip.`,
    );
  }
  const uploaded = await uploadVocalsSliceClip(localPath, {
    title: row.title?.trim() || `Editor audio ${id}`,
  });
  const clipId = Number(uploaded.clipId);
  if (!Number.isFinite(clipId) || clipId <= 0) {
    throw new Error(`Asset ${id} uploaded but has no clip id.`);
  }
  return { kind: "clip", clipId };
}

/**
 * Parascene CDN full mix → `audio_creation_id` + window.
 * Local / vocals / non-CDN → record a library clip and pass `audio_clip_id`.
 */
export function parasceneProductTimelineAudioKind(
  mode: TimelineAudioMode,
  audioCreation:
    | Pick<Creation, "id" | "mediaType" | "remoteUrl" | "remoteJson">
    | null
    | undefined,
  volumePercent = 100,
  combinedMix = false,
): ParasceneProductTimelineAudioKind {
  if (mode === "none") return "none";
  // A1+A2 (or stacked A1) must be a local slice of the baked mix — a CDN
  // window on one Creation drops the other track.
  if (combinedMix) return "audio_clip";
  if (
    mode === "full_mix" &&
    creationSupportsCdnAudioWindow(audioCreation) &&
    clipVolumeIsUnity({ volume: volumePercent })
  ) {
    return "cdn_window";
  }
  return "audio_clip";
}

/** Generate window in timeline seconds (clamped add-asset duration). */
export function placeholderTimelineAudioWindow(placeholder: TimelineClip): {
  startSec: number;
  endSec: number;
  durationSec: number;
} {
  const durationSec = addAssetClipDurationSec(placeholder);
  const startSec = Number(placeholder.startSec);
  const start = Number.isFinite(startSec) ? startSec : 0;
  return { startSec: start, endSec: start + durationSec, durationSec };
}

export function unlinkedAudioClipsInWindow(
  timeline: readonly TimelineClip[],
  startSec: number,
  endSec: number,
): TimelineClip[] {
  return timeline.filter((clip) => {
    if (clip.linkedVideoClipId?.trim()) return false;
    if (!(clip.lane === "audio" || clip.kind === "audio")) return false;
    if (!clip.assetId?.trim()) return false;
    return clip.startSec < endSec - 1e-4 && clip.endSec > startSec + 1e-4;
  });
}

/**
 * True when the generate window has more than one audio bed (A1+A2, stacked
 * A1, or A2 alone). Slice the baked timeline mix, not one asset file.
 */
export function placeholderNeedsCombinedTimelineAudio(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
): boolean {
  const { startSec, endSec } = placeholderTimelineAudioWindow(placeholder);
  const clips = unlinkedAudioClipsInWindow(timeline, startSec, endSec);
  if (clips.length >= 2) return true;
  return clips.some((clip) => clipAudioTrack(clip) === 2);
}

/**
 * Timeline audio instance whose window is sliced for A2V. Prefer the
 * instance that actually covers the placeholder when the same asset is
 * placed more than once.
 */
export function timelineReferenceAudioClip(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): TimelineClip | null {
  const main = resolveAlignmentAudioClip(
    timeline,
    alignment,
    mainAudioCreationId,
  );
  if (!main) return null;
  const assetId = main.assetId?.trim();
  if (!assetId) return main;
  const overlapping = timeline.filter((clip) => {
    if (clip.linkedVideoClipId?.trim()) return false;
    if (!(clip.lane === "audio" || clip.kind === "audio")) return false;
    if (clip.assetId?.trim() !== assetId) return false;
    return (
      clip.startSec < placeholder.endSec - 1e-4 &&
      clip.endSec > placeholder.startSec + 1e-4
    );
  });
  return overlapping[0] ?? main;
}

export function timelineReferenceVolumeGain(
  timeline: readonly TimelineClip[],
  placeholder: TimelineClip,
  mainAudioCreationId: string | null,
  alignment?: LyricAlignment | null,
): number {
  return clipVolumeGain(
    timelineReferenceAudioClip(
      timeline,
      placeholder,
      mainAudioCreationId,
      alignment,
    ),
  );
}

export async function slicePlaceholderTimelineAudio(opts: {
  mode: Exclude<TimelineAudioMode, "none">;
  mainAudioCreationId: string | null;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  lyricAlignment?: LyricAlignment | null;
  projectId?: string | null;
  /** Monitor bake path — slice this instead of writing a new mix in that folder. */
  timelineAudioBakePath?: string | null;
}): Promise<{ path: string; durationSec: number; inSec: number }> {
  if (
    placeholderNeedsCombinedTimelineAudio(opts.timeline, opts.placeholder)
  ) {
    return sliceCombinedTimelineAudio(opts);
  }
  const audioId = opts.mainAudioCreationId?.trim();
  if (!audioId) {
    throw new Error(
      "Add main audio to the timeline (or set it in Lab) before generating.",
    );
  }
  const { durationSec, songRange } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    audioId,
    opts.lyricAlignment ?? null,
  );
  const inSec = songRange.startSec;
  const outSec = inSec + durationSec;
  if (!(outSec > inSec)) {
    throw new Error("Invalid song time range for this clip.");
  }
  const [audioRow] = await getCreations([audioId]);
  const mixPath = audioRow?.localPath?.trim();
  if (!mixPath) {
    throw new Error("Main audio is not available locally yet.");
  }
  const volume = timelineReferenceVolumeGain(
    opts.timeline,
    opts.placeholder,
    audioId,
    opts.lyricAlignment ?? null,
  );
  const slice =
    opts.mode === "full_mix"
      ? await sliceAudioRange({
          sourcePath: mixPath,
          inSec,
          outSec,
          volume,
        })
      : await isolateVocalsRange({
          sourcePath: mixPath,
          inSec,
          outSec,
          volume,
        });
  return { path: slice.path, durationSec, inSec };
}

async function sliceCombinedTimelineAudio(opts: {
  mode: Exclude<TimelineAudioMode, "none">;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  projectId?: string | null;
  timelineAudioBakePath?: string | null;
}): Promise<{ path: string; durationSec: number; inSec: number }> {
  const projectId = opts.projectId?.trim();
  if (!projectId) {
    throw new Error("Project is missing — cannot mix timeline audio.");
  }
  const { startSec, endSec, durationSec } = placeholderTimelineAudioWindow(
    opts.placeholder,
  );
  if (!(endSec > startSec)) {
    throw new Error("Invalid timeline range for this clip.");
  }
  const mixPath = await resolveCombinedMixPath(opts);
  // Mix is timeline-time from 0. Do not map through one clip's source in/out.
  let window;
  try {
    window = await sliceAudioRange({
      sourcePath: mixPath,
      inSec: startSec,
      outSec: endSec,
    });
  } catch (error) {
    if (!opts.timelineAudioBakePath?.trim()) throw error;
    const fallback = await bakeGenerateTimelineAudio(projectId, opts.timeline);
    window = await sliceAudioRange({
      sourcePath: fallback.path,
      inSec: startSec,
      outSec: endSec,
    });
  }
  if (opts.mode === "full_mix") {
    return { path: window.path, durationSec, inSec: startSec };
  }
  const vocals = await isolateVocalsRange({
    sourcePath: window.path,
    inSec: 0,
    outSec: durationSec,
  });
  return { path: vocals.path, durationSec, inSec: startSec };
}

/** Prefer the monitor bake so generate never rewrites that folder. */
export function monitorBakePathForGenerateSlice(
  timelineAudioBakePath?: string | null,
): string | null {
  const path = timelineAudioBakePath?.trim();
  return path || null;
}

async function resolveCombinedMixPath(opts: {
  timeline: readonly TimelineClip[];
  projectId?: string | null;
  timelineAudioBakePath?: string | null;
}): Promise<string> {
  const existing = monitorBakePathForGenerateSlice(opts.timelineAudioBakePath);
  if (existing) return existing;
  const projectId = opts.projectId?.trim();
  if (!projectId) {
    throw new Error("Project is missing — cannot mix timeline audio.");
  }
  const baked = await bakeGenerateTimelineAudio(projectId, opts.timeline);
  return baked.path;
}

/**
 * Attach timeline audio to Parascene create args. Local (non-CDN) audio is
 * recorded as a library clip — do not put the generic prompt-audio URL in
 * `input_audio_urls`; the server mints a provider-fetchable share URL from
 * `audio_clip_id`.
 */
export async function attachParasceneTimelineAudioToCreateArgs(opts: {
  args: Record<string, unknown>;
  mode: Exclude<TimelineAudioMode, "none">;
  mainAudioCreationId: string | null;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  lyricAlignment?: LyricAlignment | null;
  projectId?: string | null;
  timelineAudioBakePath?: string | null;
  onProgress: (note: string) => void;
}): Promise<ParasceneProductTimelineAudioKind> {
  const audioId = opts.mainAudioCreationId?.trim();
  const combined = placeholderNeedsCombinedTimelineAudio(
    opts.timeline,
    opts.placeholder,
  );
  if (!combined && !audioId) {
    throw new Error(
      "Add main audio to the timeline (or set it in Lab) before generating.",
    );
  }
  const [audioRow] = audioId ? await getCreations([audioId]) : [];
  const volumePercent = clipVolumePercent(
    timelineReferenceAudioClip(
      opts.timeline,
      opts.placeholder,
      audioId ?? null,
      opts.lyricAlignment ?? null,
    ),
  );
  const kind = parasceneProductTimelineAudioKind(
    opts.mode,
    audioRow,
    volumePercent,
    combined,
  );
  const { durationSec, songRange } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    audioId ?? null,
    opts.lyricAlignment ?? null,
  );
  if (kind === "cdn_window" && audioId) {
    attachAudioCreationRangeArgs(opts.args, {
      creationId: Number(audioId),
      startSec: songRange.startSec,
      durationSec,
    });
    return kind;
  }

  opts.onProgress(
    opts.mode === "vocals"
      ? "Preparing timeline vocals slice…"
      : "Preparing timeline audio slice…",
  );
  const sliced = await slicePlaceholderTimelineAudio({
    mode: opts.mode,
    mainAudioCreationId: audioId ?? null,
    timeline: opts.timeline,
    placeholder: opts.placeholder,
    lyricAlignment: opts.lyricAlignment ?? null,
    projectId: opts.projectId,
    timelineAudioBakePath: opts.timelineAudioBakePath,
  });
  opts.onProgress("Uploading audio clip…");
  const uploaded = await uploadVocalsSliceClip(sliced.path, {
    title:
      opts.mode === "vocals"
        ? `Editor vocals ${sliced.inSec.toFixed(1)}–${(sliced.inSec + sliced.durationSec).toFixed(1)}s`
        : `Editor mix ${sliced.inSec.toFixed(1)}–${(sliced.inSec + sliced.durationSec).toFixed(1)}s`,
    durationSec: sliced.durationSec,
  });
  attachParasceneAudioClipId(opts.args, uploaded.clipId);
  return kind;
}
