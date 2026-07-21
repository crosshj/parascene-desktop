/** Map provided lyric lines onto speech-recognition segment timings. */

import type { AlignedLyricLine } from "../project/types";
import { openAiChatCompletion } from "./openaiClient";
import type { TranscriptSegment } from "./transcribe";

export function parseLyricLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function roundSec(n: number): number {
  return Number(n.toFixed(3));
}

/** Greedy sequential match when the LLM step is unavailable. */
export function alignLyricsHeuristic(opts: {
  lines: string[];
  segments: TranscriptSegment[];
  durationSec: number;
}): AlignedLyricLine[] {
  const { lines, segments, durationSec } = opts;
  if (lines.length === 0) return [];
  if (segments.length === 0) {
    const span = durationSec / lines.length;
    return lines.map((line, i) => ({
      line,
      startSec: roundSec(i * span),
      endSec: roundSec((i + 1) * span),
      confidence: 0.1,
    }));
  }

  let segIdx = 0;
  return lines.map((line) => {
    const words = line.toLowerCase().split(/\s+/).filter(Boolean);
    const startSeg = segments[segIdx];
    if (!startSeg) {
      const t = durationSec;
      return { line, startSec: t, endSec: t, confidence: 0.05 };
    }
    const startSec = startSeg.startSec;
    let endSec = startSeg.endSec;
    let matched = 0;
    while (segIdx < segments.length && matched < words.length) {
      endSec = segments[segIdx].endSec;
      const segWords = segments[segIdx].text.toLowerCase().split(/\s+/).filter(Boolean);
      matched += segWords.length;
      segIdx += 1;
    }
    return {
      line,
      startSec: roundSec(startSec),
      endSec: roundSec(Math.max(endSec, startSec + 0.05)),
      confidence: 0.35,
    };
  });
}

export async function alignLyricsToTranscript(opts: {
  lines: string[];
  segments: TranscriptSegment[];
  durationSec: number;
  apiKey: string;
}): Promise<AlignedLyricLine[]> {
  const { lines, segments, durationSec, apiKey } = opts;
  if (lines.length === 0) throw new Error("Paste lyrics");
  if (segments.length === 0) {
    return alignLyricsHeuristic({ lines, segments, durationSec });
  }

  const user = JSON.stringify(
    {
      durationSec,
      lyricLines: lines,
      transcriptSegments: segments.map((s) => ({
        text: s.text,
        startSec: s.startSec,
        endSec: s.endSec,
      })),
      instruction:
        "Align each lyric line to the song timeline. Return JSON { lines: [{ line, startSec, endSec, confidence }] } with one entry per lyric line in order. startSec/endSec must be within [0, durationSec], non-overlapping or lightly overlapping is ok, endSec > startSec. confidence is 0..1 for how sure you are. Use transcript timings; lyric text is ground truth even when transcription wording differs.",
    },
    null,
    2,
  );

  const result = await openAiChatCompletion({
    apiKey,
    jsonMode: true,
    system:
      "You align song lyrics to speech-recognition timestamps. Reply with JSON only.",
    user,
  });

  let parsed: { lines?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(result.content) as { lines?: unknown[] };
  } catch {
    parsed = null;
  }

  const fromLlm: AlignedLyricLine[] = [];
  for (let i = 0; i < (parsed?.lines ?? []).length; i++) {
    const row = (parsed?.lines ?? [])[i];
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const line =
      typeof r.line === "string" && r.line.trim()
        ? r.line.trim()
        : lines[i] ?? "";
    const startSec = Number(r.startSec);
    const endSec = Number(r.endSec);
    if (!line || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    const confidence = Number(r.confidence);
    fromLlm.push({
      line,
      startSec: roundSec(Math.max(0, startSec)),
      endSec: roundSec(Math.min(durationSec, Math.max(endSec, startSec + 0.05))),
      confidence:
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : 0.5,
    });
  }

  if (fromLlm.length === lines.length) return fromLlm;
  return alignLyricsHeuristic({ lines, segments, durationSec });
}
