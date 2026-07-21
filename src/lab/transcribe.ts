/** Speech-to-text with segment + word timings for Lab lyric align. */

import { invoke } from "@tauri-apps/api/core";
import { audioWaveformPeaks, sliceAudioRange } from "./audioTools";
import {
  detectVocalBlocks,
  padVocalBlock,
  type VocalBlock,
} from "./vocalBlocks";

export type TranscriptSegment = {
  text: string;
  startSec: number;
  endSec: number;
};

export type TranscriptWord = {
  word: string;
  startSec: number;
  endSec: number;
};

export type TranscriptResult = {
  engine: "openai" | "local";
  segments: TranscriptSegment[];
  words: TranscriptWord[];
  fullText: string;
  language?: string;
  /** Vocal regions detected from silence gaps before block-wise transcription. */
  vocalBlocks?: VocalBlock[];
};

export type TranscribeEngine = "openai" | "local";

function normalizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const startSec = Number(row.startSec ?? row.start);
    const endSec = Number(row.endSec ?? row.end);
    if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (endSec <= startSec) continue;
    out.push({ text, startSec, endSec });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

function normalizeWords(raw: unknown): TranscriptWord[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptWord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const word =
      typeof row.word === "string"
        ? row.word.trim()
        : typeof row.text === "string"
          ? row.text.trim()
          : "";
    const startSec = Number(row.startSec ?? row.start);
    const endSec = Number(row.endSec ?? row.end);
    if (!word || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (endSec <= startSec) continue;
    out.push({ word, startSec, endSec });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

const VOCAL_ENERGY_RATIO = 0.1;
const VOCAL_TAIL_PAD_SEC = 0.25;
const BLOCK_TRANSCRIBE_MIN_BLOCKS = 2;

function vocalEnergyThreshold(peaks: number[]): number {
  const globalMax = Math.max(...peaks, 1e-6);
  return globalMax * VOCAL_ENERGY_RATIO;
}

function bucketRangeForSec(
  startSec: number,
  endSec: number,
  durationSec: number,
  bucketCount: number,
): { start: number; end: number } {
  const start = Math.min(
    bucketCount - 1,
    Math.max(0, Math.floor((startSec / durationSec) * bucketCount)),
  );
  const end = Math.min(
    bucketCount - 1,
    Math.max(start, Math.ceil((endSec / durationSec) * bucketCount)),
  );
  return { start, end };
}

function rangeHasVocalEnergy(
  peaks: number[],
  startSec: number,
  endSec: number,
  durationSec: number,
  threshold: number,
): boolean {
  if (durationSec <= 0 || peaks.length === 0) return false;
  const { start, end } = bucketRangeForSec(
    startSec,
    endSec,
    durationSec,
    peaks.length,
  );
  for (let i = start; i <= end; i++) {
    if (peaks[i] >= threshold) return true;
  }
  return false;
}

function lastVocalEndSec(
  peaks: number[],
  durationSec: number,
  threshold: number,
): number {
  const bucketSec = durationSec / peaks.length;
  for (let i = peaks.length - 1; i >= 0; i--) {
    if (peaks[i] >= threshold) {
      return Math.min(durationSec, (i + 1) * bucketSec + VOCAL_TAIL_PAD_SEC);
    }
  }
  return 0;
}

/** Drop Whisper words that fall in silent regions of the vocals stem. */
export function filterWordsByVocalPeaks(
  words: TranscriptWord[],
  peaks: number[],
  durationSec: number,
): TranscriptWord[] {
  if (!words.length || !peaks.length || durationSec <= 0) return words;
  const threshold = vocalEnergyThreshold(peaks);
  const vocalEnd = lastVocalEndSec(peaks, durationSec, threshold);

  return words.filter((word) => {
    if (word.startSec > vocalEnd) return false;
    return rangeHasVocalEnergy(
      peaks,
      word.startSec,
      word.endSec,
      durationSec,
      threshold,
    );
  });
}

function filterSegmentsToWords(
  segments: TranscriptSegment[],
  words: TranscriptWord[],
  peaks: number[],
  durationSec: number,
): TranscriptSegment[] {
  if (!segments.length) return segments;
  const threshold = vocalEnergyThreshold(peaks);
  const vocalEnd = lastVocalEndSec(peaks, durationSec, threshold);

  return segments.filter((seg) => {
    if (seg.startSec > vocalEnd) return false;
    const hasWord = words.some(
      (w) => w.startSec < seg.endSec && w.endSec > seg.startSec,
    );
    if (hasWord) return true;
    return rangeHasVocalEnergy(
      peaks,
      seg.startSec,
      seg.endSec,
      durationSec,
      threshold,
    );
  });
}

function offsetTranscript(
  transcript: TranscriptResult,
  offsetSec: number,
): TranscriptResult {
  if (offsetSec === 0) return transcript;
  return {
    ...transcript,
    segments: transcript.segments.map((seg) => ({
      ...seg,
      startSec: seg.startSec + offsetSec,
      endSec: seg.endSec + offsetSec,
    })),
    words: transcript.words.map((word) => ({
      ...word,
      startSec: word.startSec + offsetSec,
      endSec: word.endSec + offsetSec,
    })),
  };
}

function mergeTranscripts(
  parts: TranscriptResult[],
  vocalBlocks: VocalBlock[],
): TranscriptResult {
  const engine = parts[0]?.engine ?? "openai";
  const language = parts.find((p) => p.language)?.language;
  const segments = parts
    .flatMap((p) => p.segments)
    .sort((a, b) => a.startSec - b.startSec);
  const words = parts
    .flatMap((p) => p.words)
    .sort((a, b) => a.startSec - b.startSec);
  return {
    engine,
    segments,
    words,
    fullText: words.map((w) => w.word.trim()).filter(Boolean).join(" "),
    language,
    vocalBlocks,
  };
}

/** Align Whisper output to vocal energy on the source stem (drops silence hallucinations). */
export async function filterTranscriptToVocalActivity(
  transcript: TranscriptResult,
  audioPath: string,
): Promise<TranscriptResult> {
  if (!transcript.words.length) return transcript;
  try {
    const { peaks, durationSec } = await audioWaveformPeaks(audioPath, 512);
    if (durationSec <= 0 || peaks.length === 0) return transcript;

    const words = filterWordsByVocalPeaks(transcript.words, peaks, durationSec);
    const segments = filterSegmentsToWords(
      transcript.segments,
      words,
      peaks,
      durationSec,
    );
    return {
      ...transcript,
      words,
      segments,
      fullText: words.map((w) => w.word.trim()).filter(Boolean).join(" "),
    };
  } catch {
    return transcript;
  }
}

async function readAudioBytes(path: string): Promise<Uint8Array> {
  const base64 = await invoke<string>("library_read_file_base64", { path });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function prepareOpenAiWhisperAudio(audioPath: string): Promise<string> {
  return invoke<string>("library_prepare_openai_whisper_audio", {
    audioPath,
  });
}

async function transcribeOpenAiRaw(opts: {
  audioPath: string;
  apiKey: string;
}): Promise<TranscriptResult> {
  const uploadPath = await prepareOpenAiWhisperAudio(opts.audioPath);
  const bytes = await readAudioBytes(uploadPath);
  const blob = new Blob([bytes], { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", blob, "vocals.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey.trim()}` },
    body: form,
  });
  const body = (await res.json()) as {
    error?: { message?: string };
    text?: string;
    language?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };
  if (!res.ok) {
    throw new Error(body.error?.message || `OpenAI transcription HTTP ${res.status}`);
  }
  const segments = normalizeSegments(
    (body.segments ?? []).map((s) => ({
      text: s.text,
      startSec: s.start,
      endSec: s.end,
    })),
  );
  const words = normalizeWords(
    (body.words ?? []).map((w) => ({
      word: w.word,
      startSec: w.start,
      endSec: w.end,
    })),
  );
  return {
    engine: "openai",
    segments,
    words,
    fullText: body.text?.trim() || segments.map((s) => s.text).join(" ").trim(),
    language: body.language,
  };
}

async function transcribeLocalRaw(audioPath: string): Promise<TranscriptResult> {
  const result = await invoke<{
    segments: TranscriptSegment[];
    words: TranscriptWord[];
    fullText: string;
    language?: string;
  }>("library_transcribe_local", { audioPath });
  return {
    engine: "local",
    segments: normalizeSegments(result.segments),
    words: normalizeWords(result.words),
    fullText: result.fullText?.trim() || "",
    language: result.language,
  };
}

async function transcribeClipRaw(opts: {
  audioPath: string;
  engine: TranscribeEngine;
  apiKey?: string;
}): Promise<TranscriptResult> {
  if (opts.engine === "openai") {
    const apiKey = opts.apiKey?.trim();
    if (!apiKey) {
      throw new Error(
        "OpenAI API key missing — set it in Settings for cloud transcription.",
      );
    }
    return transcribeOpenAiRaw({ audioPath: opts.audioPath, apiKey });
  }
  return transcribeLocalRaw(opts.audioPath);
}

async function transcribeFullTrack(opts: {
  audioPath: string;
  engine: TranscribeEngine;
  apiKey?: string;
  vocalBlocks: VocalBlock[];
}): Promise<TranscriptResult> {
  const raw = await transcribeClipRaw(opts);
  const filtered = await filterTranscriptToVocalActivity(raw, opts.audioPath);
  return { ...filtered, vocalBlocks: opts.vocalBlocks };
}

async function transcribeByVocalBlocks(opts: {
  audioPath: string;
  engine: TranscribeEngine;
  apiKey?: string;
  vocalBlocks: VocalBlock[];
  durationSec: number;
  onProgress?: (note: string) => void;
}): Promise<TranscriptResult> {
  const parts: TranscriptResult[] = [];
  for (let i = 0; i < opts.vocalBlocks.length; i++) {
    const block = padVocalBlock(opts.vocalBlocks[i], opts.durationSec);
    opts.onProgress?.(
      `Transcribing vocal section ${i + 1}/${opts.vocalBlocks.length} (${block.startSec.toFixed(1)}s–${block.endSec.toFixed(1)}s)…`,
    );
    const slice = await sliceAudioRange({
      sourcePath: opts.audioPath,
      inSec: block.startSec,
      outSec: block.endSec,
    });
    const blockTranscript = await transcribeClipRaw({
      audioPath: slice.path,
      engine: opts.engine,
      apiKey: opts.apiKey,
    });
    parts.push(offsetTranscript(blockTranscript, block.startSec));
  }
  return mergeTranscripts(parts, opts.vocalBlocks);
}

export async function transcribeAudio(opts: {
  audioPath: string;
  engine: TranscribeEngine;
  apiKey?: string;
  onProgress?: (note: string) => void;
}): Promise<TranscriptResult> {
  const { peaks, durationSec } = await audioWaveformPeaks(opts.audioPath, 512);
  const vocalBlocks = detectVocalBlocks(peaks, durationSec);

  if (vocalBlocks.length === 0) {
    opts.onProgress?.("No vocal sections detected on the stem.");
    return {
      engine: opts.engine,
      segments: [],
      words: [],
      fullText: "",
      vocalBlocks: [],
    };
  }

  const useBlockMode = vocalBlocks.length >= BLOCK_TRANSCRIBE_MIN_BLOCKS;

  if (!useBlockMode) {
    opts.onProgress?.(
      vocalBlocks.length === 1
        ? "Transcribing vocals (single section)…"
        : "Transcribing vocals…",
    );
    return transcribeFullTrack({
      audioPath: opts.audioPath,
      engine: opts.engine,
      apiKey: opts.apiKey,
      vocalBlocks,
    });
  }

  opts.onProgress?.(
    `Detected ${vocalBlocks.length} vocal sections separated by silence…`,
  );
  return transcribeByVocalBlocks({
    ...opts,
    vocalBlocks,
    durationSec,
  });
}

/** @deprecated Use transcribeAudio — kept for direct tests/callers. */
export async function transcribeWithOpenAi(opts: {
  audioPath: string;
  apiKey: string;
}): Promise<TranscriptResult> {
  return transcribeAudio({
    audioPath: opts.audioPath,
    engine: "openai",
    apiKey: opts.apiKey,
  });
}

/** @deprecated Use transcribeAudio — kept for direct tests/callers. */
export async function transcribeWithLocalWhisper(opts: {
  audioPath: string;
}): Promise<TranscriptResult> {
  return transcribeAudio({ audioPath: opts.audioPath, engine: "local" });
}
