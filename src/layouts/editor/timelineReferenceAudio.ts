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
import type { LyricAlignment, TimelineClip } from "../../project/types";
import { resolveAddAssetGenerationTiming } from "./addAssetStartFrame";
import type { TimelineAudioMode } from "./generateMediaRefs";

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
): ParasceneProductTimelineAudioKind {
  if (mode === "none") return "none";
  if (mode === "full_mix" && creationSupportsCdnAudioWindow(audioCreation)) {
    return "cdn_window";
  }
  return "audio_clip";
}

export async function slicePlaceholderTimelineAudio(opts: {
  mode: Exclude<TimelineAudioMode, "none">;
  mainAudioCreationId: string | null;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  lyricAlignment?: LyricAlignment | null;
}): Promise<{ path: string; durationSec: number; inSec: number }> {
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
  const slice =
    opts.mode === "full_mix"
      ? await sliceAudioRange({
          sourcePath: mixPath,
          inSec,
          outSec,
        })
      : await isolateVocalsRange({
          sourcePath: mixPath,
          inSec,
          outSec,
        });
  return { path: slice.path, durationSec, inSec };
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
  onProgress: (note: string) => void;
}): Promise<ParasceneProductTimelineAudioKind> {
  const audioId = opts.mainAudioCreationId?.trim();
  if (!audioId) {
    throw new Error(
      "Add main audio to the timeline (or set it in Lab) before generating.",
    );
  }
  const [audioRow] = await getCreations([audioId]);
  const kind = parasceneProductTimelineAudioKind(opts.mode, audioRow);
  const { durationSec, songRange } = resolveAddAssetGenerationTiming(
    opts.timeline,
    opts.placeholder,
    audioId,
    opts.lyricAlignment ?? null,
  );
  if (kind === "cdn_window") {
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
    mainAudioCreationId: audioId,
    timeline: opts.timeline,
    placeholder: opts.placeholder,
    lyricAlignment: opts.lyricAlignment ?? null,
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
