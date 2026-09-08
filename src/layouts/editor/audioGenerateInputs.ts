import {
  findCuratedAudioModel,
  REPLICATE_VOICE_CLONE_MODEL,
  type CuratedAudioModelId,
} from "./replicateAudioModels";

export type ReplicateAudioGenerateExtras = {
  voiceId?: string;
  geminiVoice?: string;
  stylePrompt?: string;
  lyrics?: string;
  instrumental?: boolean;
  lyricsOptimizer?: boolean;
  emotion?: string;
  /** Project audio asset used for MiniMax voice clone. */
  cloneSourceAssetId?: string;
};

export function persistAudioGenerateExtras(
  extras?: ReplicateAudioGenerateExtras | null,
): ReplicateAudioGenerateExtras | undefined {
  if (!extras) return undefined;
  const next: ReplicateAudioGenerateExtras = {};
  const voiceId = extras.voiceId?.trim();
  if (voiceId) next.voiceId = voiceId;
  const geminiVoice = extras.geminiVoice?.trim();
  if (geminiVoice) next.geminiVoice = geminiVoice;
  const stylePrompt = extras.stylePrompt?.trim();
  if (stylePrompt) next.stylePrompt = stylePrompt;
  const lyrics = extras.lyrics?.trim();
  if (lyrics) next.lyrics = lyrics;
  if (extras.instrumental === true) next.instrumental = true;
  if (extras.lyricsOptimizer === true) next.lyricsOptimizer = true;
  const emotion = extras.emotion?.trim();
  if (emotion) next.emotion = emotion;
  const cloneSourceAssetId = extras.cloneSourceAssetId?.trim();
  if (cloneSourceAssetId) next.cloneSourceAssetId = cloneSourceAssetId;
  return Object.keys(next).length > 0 ? next : undefined;
}

const AUDIO_EXT = /\.(mp3|m4a|wav|aac|ogg|flac|webm)$/i;

export function isAudioMediaPath(path: string | null | undefined): boolean {
  const value = path?.trim() ?? "";
  if (!value) return false;
  if (value.toLowerCase().endsWith(".json")) return false;
  return AUDIO_EXT.test(value) || /^https?:\/\//i.test(value);
}

export function pickLocalAudioPath(
  paths: readonly string[] | null | undefined,
): string | null {
  for (const path of paths ?? []) {
    const trimmed = path.trim();
    if (trimmed && AUDIO_EXT.test(trimmed)) return trimmed;
  }
  return null;
}

export function buildReplicateAudioInput(opts: {
  modelId: string;
  text: string;
  extras?: ReplicateAudioGenerateExtras;
}): Record<string, unknown> {
  const text = opts.text.trim();
  const extras = opts.extras ?? {};
  const def = findCuratedAudioModel(opts.modelId);
  const modelId = (def?.id ?? opts.modelId.trim()) as CuratedAudioModelId | string;

  if (modelId === "minimax/speech-2.8-hd") {
    const input: Record<string, unknown> = { text };
    const voiceId = extras.voiceId?.trim();
    if (voiceId) input.voice_id = voiceId;
    const emotion = extras.emotion?.trim();
    if (emotion) input.emotion = emotion;
    return input;
  }

  if (modelId === "google/gemini-3.1-flash-tts") {
    const input: Record<string, unknown> = { text };
    const voice = extras.geminiVoice?.trim() || extras.voiceId?.trim();
    if (voice) input.voice = voice;
    const style = extras.stylePrompt?.trim();
    if (style) input.prompt = style;
    return input;
  }

  if (modelId === "google/lyria-3") {
    return { prompt: text };
  }

  if (modelId === "minimax/music-2.6") {
    const input: Record<string, unknown> = { prompt: text };
    const lyrics = extras.lyrics?.trim();
    if (lyrics) input.lyrics = lyrics;
    if (extras.instrumental === true) input.is_instrumental = true;
    if (extras.lyricsOptimizer === true) input.lyrics_optimizer = true;
    return input;
  }

  return def?.textField === "text" ? { text } : { prompt: text };
}

export function buildVoiceCloneInput(): Record<string, unknown> {
  return { model: REPLICATE_VOICE_CLONE_MODEL };
}

export function parseVoiceCloneOutput(result: {
  outputPreview?: string | null;
  outputUrls?: string[] | null;
  localPaths?: string[] | null;
}): { voiceId: string; previewPath: string | null; previewUrl: string | null } {
  const voiceId = extractVoiceId(result.outputPreview) ?? "";
  const previewPath = pickLocalAudioPath(result.localPaths);
  const previewUrl =
    (result.outputUrls ?? []).map((u) => u.trim()).find((u) => isAudioMediaPath(u)) ??
    extractPreviewUrl(result.outputPreview);
  return {
    voiceId,
    previewPath,
    previewUrl,
  };
}

function extractVoiceId(preview: string | null | undefined): string | null {
  const parsed = parsePreviewObject(preview);
  if (!parsed) return null;
  const raw = parsed.voice_id ?? parsed.voiceId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function extractPreviewUrl(preview: string | null | undefined): string | null {
  const parsed = parsePreviewObject(preview);
  if (!parsed) return null;
  const raw = parsed.preview ?? parsed.preview_url ?? parsed.previewUrl;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function parsePreviewObject(
  preview: string | null | undefined,
): Record<string, unknown> | null {
  const raw = preview?.trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}
