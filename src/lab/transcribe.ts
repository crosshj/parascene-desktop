/** Speech-to-text with segment timings for Lab lyric align. */

import { invoke } from "@tauri-apps/api/core";

export type TranscriptSegment = {
  text: string;
  startSec: number;
  endSec: number;
};

export type TranscriptResult = {
  engine: "openai" | "local";
  segments: TranscriptSegment[];
  fullText: string;
  language?: string;
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

async function readAudioBytes(path: string): Promise<Uint8Array> {
  const base64 = await invoke<string>("library_read_file_base64", { path });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** OpenAI Whisper API — segment timestamps via verbose_json. */
export async function transcribeWithOpenAi(opts: {
  audioPath: string;
  apiKey: string;
}): Promise<TranscriptResult> {
  const bytes = await readAudioBytes(opts.audioPath);
  const blob = new Blob([bytes], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "vocals.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

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
  return {
    engine: "openai",
    segments,
    fullText: body.text?.trim() || segments.map((s) => s.text).join(" ").trim(),
    language: body.language,
  };
}

/** Local Whisper CLI (openai-whisper Python package) via Tauri. */
export async function transcribeWithLocalWhisper(opts: {
  audioPath: string;
}): Promise<TranscriptResult> {
  const result = await invoke<{
    segments: TranscriptSegment[];
    fullText: string;
    language?: string;
  }>("library_transcribe_local", { audioPath: opts.audioPath });
  return {
    engine: "local",
    segments: normalizeSegments(result.segments),
    fullText: result.fullText?.trim() || "",
    language: result.language,
  };
}

export async function transcribeAudio(opts: {
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
    return transcribeWithOpenAi({ audioPath: opts.audioPath, apiKey });
  }
  return transcribeWithLocalWhisper({ audioPath: opts.audioPath });
}
