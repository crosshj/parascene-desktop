/** Map provided lyric lines onto speech-recognition segment timings. */

import type { AlignedLyricLine } from "../project/types";
import { openAiChatCompletion, OPENAI_LYRIC_ALIGN_MODEL } from "./openaiClient";
import type { TranscriptSegment, TranscriptWord } from "./transcribe";
import type { VocalBlock } from "./vocalBlocks";

export type { TranscriptWord } from "./transcribe";

export type LyricScriptItem =
  | { kind: "tag"; text: string }
  | { kind: "line"; text: string };

/** Single-line Suno tag like `[Intro]` or `[Verse 1]`. */
export function isSunoTagLine(line: string): boolean {
  return /^\[[^\]]+\]$/.test(line.trim());
}

/** True when the full block is only Suno bracket tag(s) — not sung audio. */
export function isInaudibleLyricText(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (line) =>
      isSunoTagLine(line) || (line.startsWith("[") && line.endsWith("]")),
  );
}

export function isInaudibleLyricLine(line: AlignedLyricLine): boolean {
  return line.inaudible === true || isInaudibleLyricText(line.line);
}

/**
 * Split pasted lyrics into inaudible Suno tags and singable lines.
 * Consecutive tag lines are grouped; multi-line `[tag` … `]` blocks are supported.
 */
export function parseLyricScript(text: string): LyricScriptItem[] {
  const items: LyricScriptItem[] = [];
  const tagBuffer: string[] = [];
  let multilineTag: string[] | null = null;

  const flushTags = () => {
    if (!tagBuffer.length) return;
    items.push({ kind: "tag", text: tagBuffer.join("\n") });
    tagBuffer.length = 0;
  };

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (multilineTag) {
      multilineTag.push(line);
      if (line.includes("]")) {
        tagBuffer.push(multilineTag.join("\n"));
        multilineTag = null;
      }
      continue;
    }

    if (line.startsWith("[") && !line.endsWith("]")) {
      flushTags();
      multilineTag = [line];
      continue;
    }

    if (isSunoTagLine(line)) {
      tagBuffer.push(line);
      continue;
    }

    flushTags();
    items.push({ kind: "line", text: line });
  }

  if (multilineTag?.length) {
    tagBuffer.push(multilineTag.join("\n"));
  }
  flushTags();
  return items;
}

/** Singable lyric lines only — excludes Suno `[tag]` markers. */
export function parseLyricLines(text: string): string[] {
  return parseLyricScript(text)
    .filter((item): item is { kind: "line"; text: string } => item.kind === "line")
    .map((item) => item.text);
}

function roundSec(n: number): number {
  return Number(n.toFixed(3));
}

const MIN_BLOCK_SEC = 0.05;
/** Guardrail for one-shot AI align payloads (typical song ≈ 200–800 words). */
const OPENAI_ALIGN_MAX_WORDS = 3000;

type WordIndexRange = { wordStart: number; wordEnd: number };

/**
 * Trim overlapping sung blocks only — preserve each line's end time when the
 * next line starts later (gaps are OK).
 */
export function enforceNonOverlappingAlignedLines(
  lines: AlignedLyricLine[],
  durationSec?: number,
): AlignedLyricLine[] {
  if (lines.length === 0) return [];

  const out = lines.map((row) => ({ ...row }));
  let prevSungIdx = -1;

  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    if (isInaudibleLyricLine(cur)) continue;

    if (prevSungIdx >= 0) {
      const prev = out[prevSungIdx];
      if (cur.startSec < prev.startSec) {
        cur.startSec = roundSec(prev.startSec + MIN_BLOCK_SEC);
      }
      if (cur.startSec < prev.endSec) {
        prev.endSec = roundSec(cur.startSec);
        if (prev.endSec <= prev.startSec) {
          prev.endSec = roundSec(prev.startSec + MIN_BLOCK_SEC);
          if (cur.startSec < prev.endSec) {
            cur.startSec = prev.endSec;
          }
        }
      }
    }

    if (cur.endSec <= cur.startSec) {
      cur.endSec = roundSec(cur.startSec + MIN_BLOCK_SEC);
    }

    prevSungIdx = i;
  }

  if (durationSec != null && durationSec > 0) {
    for (const row of out) {
      if (isInaudibleLyricLine(row)) continue;
      row.startSec = roundSec(clampSec(row.startSec, 0, durationSec));
      row.endSec = roundSec(
        clampSec(row.endSec, row.startSec + MIN_BLOCK_SEC, durationSec),
      );
    }
  }

  return out;
}

function clampSec(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function normToken(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9']/g, "");
}

function tokenizeLine(text: string): string[] {
  return text.split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

function tokensMatch(a: string, b: string): boolean {
  const na = normToken(a);
  const nb = normToken(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(nb) || nb.startsWith(na);
}

/** Words whose timings overlap a vocal section (used for tests / vocal activity). */
export function selectWordsForVocalBlock(
  words: TranscriptWord[],
  block: VocalBlock,
): TranscriptWord[] {
  return words.filter(
    (word) => word.startSec < block.endSec && word.endSec > block.startSec,
  );
}

function compactVocalActivity(
  vocalBlocks?: VocalBlock[],
): Array<{ startSec: number; endSec: number }> | undefined {
  if (!vocalBlocks?.length) return undefined;
  return vocalBlocks.map((block) => ({
    startSec: roundSec(block.startSec),
    endSec: roundSec(block.endSec),
  }));
}

function alignLyricsFromWordsSingle(opts: {
  lines: string[];
  words: TranscriptWord[];
  durationSec: number;
}): AlignedLyricLine[] {
  const { lines, words, durationSec } = opts;
  if (lines.length === 0) return [];
  if (words.length === 0) {
    const span = durationSec / lines.length;
    return enforceNonOverlappingAlignedLines(
      lines.map((line, i) => ({
        line,
        startSec: roundSec(i * span),
        endSec: roundSec((i + 1) * span),
        confidence: 0.1,
      })),
      durationSec,
    );
  }

  let wordIdx = 0;
  const aligned = lines.map((line) => {
    const lineWords = tokenizeLine(line);
    if (lineWords.length === 0) {
      const t = wordIdx < words.length ? words[wordIdx].startSec : durationSec;
      return { line, startSec: roundSec(t), endSec: roundSec(t), confidence: 0.05 };
    }

    let matchStart = -1;
    let matchEnd = -1;
    let searchFrom = wordIdx;
    let matchedCount = 0;

    for (const lyricWord of lineWords) {
      let found = false;
      for (let ti = searchFrom; ti < words.length; ti++) {
        if (tokensMatch(words[ti].word, lyricWord)) {
          if (matchStart < 0) matchStart = ti;
          matchEnd = ti;
          searchFrom = ti + 1;
          matchedCount += 1;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (matchStart >= 0 && matchEnd >= matchStart) {
      wordIdx = matchEnd + 1;
      const coverage = matchedCount / lineWords.length;
      return {
        line,
        startSec: roundSec(words[matchStart].startSec),
        endSec: roundSec(
          Math.max(words[matchEnd].endSec, words[matchStart].startSec + 0.05),
        ),
        confidence: Math.min(1, coverage * 0.4 + 0.5),
      };
    }

    const fallback = words[wordIdx];
    if (fallback) {
      wordIdx += 1;
      return {
        line,
        startSec: roundSec(fallback.startSec),
        endSec: roundSec(Math.max(fallback.endSec, fallback.startSec + 0.05)),
        confidence: 0.2,
      };
    }

    return { line, startSec: durationSec, endSec: durationSec, confidence: 0.05 };
  });
  return enforceNonOverlappingAlignedLines(aligned, durationSec);
}

/** Map lyric lines onto Whisper word timings (first → last matched word per line). */
export function alignLyricsFromWords(opts: {
  lines: string[];
  words: TranscriptWord[];
  durationSec: number;
}): AlignedLyricLine[] {
  return alignLyricsFromWordsSingle(opts);
}

/** Greedy word-index ranges for each lyric line (baseline for AI refinement). */
function suggestWordRangesForLines(
  lines: string[],
  words: TranscriptWord[],
): WordIndexRange[] {
  if (words.length === 0) {
    return lines.map(() => ({ wordStart: 0, wordEnd: 0 }));
  }

  let wordIdx = 0;
  return lines.map((line) => {
    const lineWords = tokenizeLine(line);
    if (lineWords.length === 0) {
      const idx = Math.min(wordIdx, words.length - 1);
      return { wordStart: idx, wordEnd: idx };
    }

    let matchStart = -1;
    let matchEnd = -1;
    let searchFrom = wordIdx;
    let matchedCount = 0;

    for (const lyricWord of lineWords) {
      let found = false;
      for (let ti = searchFrom; ti < words.length; ti++) {
        if (tokensMatch(words[ti].word, lyricWord)) {
          if (matchStart < 0) matchStart = ti;
          matchEnd = ti;
          searchFrom = ti + 1;
          matchedCount += 1;
          found = true;
          break;
        }
      }
      if (!found) break;
    }

    if (matchStart >= 0 && matchEnd >= matchStart && matchedCount > 0) {
      wordIdx = matchEnd + 1;
      return { wordStart: matchStart, wordEnd: matchEnd };
    }

    if (wordIdx < words.length) {
      const idx = wordIdx;
      wordIdx += 1;
      return { wordStart: idx, wordEnd: idx };
    }

    const last = words.length - 1;
    return { wordStart: last, wordEnd: last };
  });
}

function enforceWordIndexRanges(ranges: WordIndexRange[]): WordIndexRange[] {
  if (ranges.length === 0) return ranges;
  const out = ranges.map((r) => ({
    wordStart: Math.max(0, Math.floor(r.wordStart)),
    wordEnd: Math.max(0, Math.floor(r.wordEnd)),
  }));

  for (let i = 0; i < out.length; i++) {
    if (out[i].wordEnd < out[i].wordStart) {
      out[i].wordEnd = out[i].wordStart;
    }
    if (i > 0 && out[i].wordStart <= out[i - 1].wordEnd) {
      out[i - 1].wordEnd = out[i].wordStart - 1;
      if (out[i - 1].wordEnd < out[i - 1].wordStart) {
        out[i - 1].wordEnd = out[i - 1].wordStart;
        out[i].wordStart = out[i - 1].wordEnd + 1;
      }
    }
  }

  return out;
}

function alignedLinesFromWordRanges(
  lines: string[],
  words: TranscriptWord[],
  ranges: WordIndexRange[],
  confidences?: Array<number | undefined>,
): AlignedLyricLine[] {
  return ranges.map((range, i) => {
    const startIdx = clampSec(range.wordStart, 0, words.length - 1);
    const endIdx = clampSec(range.wordEnd, startIdx, words.length - 1);
    const confidence = confidences?.[i];
    return {
      line: lines[i] ?? "",
      startSec: roundSec(words[startIdx].startSec),
      endSec: roundSec(
        Math.max(words[endIdx].endSec, words[startIdx].startSec + MIN_BLOCK_SEC),
      ),
      confidence:
        confidence != null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : 0.5,
    };
  });
}

const LYRIC_ALIGN_SYSTEM = `You align song lyrics to a Whisper word transcript.

You do NOT invent timestamps. You only choose inclusive word index ranges into transcriptWords.
Each lyric line maps to a contiguous run of transcript word indices [wordStart, wordEnd].

Rules:
- lyricLines are canonical text (ground truth wording).
- transcriptWords are what was heard; indices are 0..N-1 in time order.
- vocalActivity (when present) lists sung regions separated by silence on the timeline.
- Respect silence gaps: do not stretch a lyric line across a gap between vocalActivity sections.
- Prefer matching words inside the vocalActivity region that fits each line's place in the song.
- One lyric line → one contiguous word index range. No overlapping index ranges.
- wordEnd is the index of the LAST sung word for that line; timings will use that word's endSec.
- line k+1 must start after line k's words end (wordStart[k+1] > wordEnd[k]); instrumental gaps are OK.
- Match by meaning and sound, allowing slang, contractions, ad-libs, and STT misspellings.
- suggestedRanges is a rough baseline — fix clear mistakes, but keep ranges plausible.
- Do not assign huge spans to a short line or squeeze many lines into a few words.

Reply JSON only:
{ "lines": [{ "lineIndex": 0, "wordStart": 0, "wordEnd": 12, "confidence": 0.9 }, ...] }
Exactly one entry per lyric line, lineIndex 0..lyricLines.length-1 in order.`;

function parseLlmWordIndexLines(
  lineCount: number,
  wordCount: number,
  content: string,
): Array<{ wordStart: number; wordEnd: number; confidence?: number }> | null {
  let parsed: { lines?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(content) as { lines?: unknown[] };
  } catch {
    return null;
  }

  const rows = parsed?.lines ?? [];
  if (rows.length !== lineCount) return null;

  const out: Array<{ wordStart: number; wordEnd: number; confidence?: number }> = [];
  for (let i = 0; i < lineCount; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    const lineIndex = Number(r.lineIndex ?? i);
    if (lineIndex !== i) return null;
    const wordStart = Number(r.wordStart);
    const wordEnd = Number(r.wordEnd ?? r.wordStart);
    if (!Number.isInteger(wordStart) || !Number.isInteger(wordEnd)) return null;
    if (wordStart < 0 || wordEnd < 0 || wordStart >= wordCount || wordEnd >= wordCount) {
      return null;
    }
    if (wordEnd < wordStart) return null;
    const confidence = Number(r.confidence);
    out.push({
      wordStart,
      wordEnd,
      confidence:
        Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : undefined,
    });
  }

  return out;
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
    return enforceNonOverlappingAlignedLines(
      lines.map((line, i) => ({
        line,
        startSec: roundSec(i * span),
        endSec: roundSec((i + 1) * span),
        confidence: 0.1,
      })),
      durationSec,
    );
  }

  let segIdx = 0;
  const aligned = lines.map((line) => {
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
  return enforceNonOverlappingAlignedLines(aligned, durationSec);
}

/** Interleave aligned singable lines with inaudible Suno tags from the script. */
export function mergeAlignedLyricsWithTags(
  script: LyricScriptItem[],
  alignedSingable: AlignedLyricLine[],
  durationSec: number,
): AlignedLyricLine[] {
  const out: AlignedLyricLine[] = [];
  let singableIdx = 0;

  for (const item of script) {
    if (item.kind === "tag") {
      const anchor =
        singableIdx < alignedSingable.length
          ? alignedSingable[singableIdx].startSec
          : durationSec;
      out.push({
        line: item.text,
        startSec: roundSec(anchor),
        endSec: roundSec(anchor),
        inaudible: true,
      });
      continue;
    }

    const row = alignedSingable[singableIdx];
    if (row) {
      out.push({ ...row, inaudible: false });
      singableIdx += 1;
    }
  }

  return enforceNonOverlappingAlignedLines(out, durationSec);
}

/** Canonical lyrics script text for a stored alignment (tags + lines). */
export function lyricsTextFromAlignedLines(
  lines: readonly AlignedLyricLine[],
): string {
  return lines.map((line) => line.line).join("\n");
}

/** Fix stored alignments where Suno tags were timed as singable segments. */
export function reconcileAlignedLinesFromScript(
  lyricsText: string,
  lines: AlignedLyricLine[],
): AlignedLyricLine[] {
  if (!lyricsText.trim() || lines.length === 0) {
    return enforceNonOverlappingAlignedLines(
      lines.map((row) =>
        isInaudibleLyricText(row.line)
          ? {
              ...row,
              inaudible: true,
              confidence: undefined,
              endSec: row.startSec,
            }
          : row,
      ),
    );
  }

  const script = parseLyricScript(lyricsText);
  if (!script.some((item) => item.kind === "tag")) {
    return enforceNonOverlappingAlignedLines(
      lines.map((row) =>
        isInaudibleLyricText(row.line)
          ? {
              ...row,
              inaudible: true,
              confidence: undefined,
              endSec: row.startSec,
            }
          : row,
      ),
    );
  }

  const durationSec = Math.max(...lines.map((line) => line.endSec), 0);
  const scriptSingable = script
    .filter((item): item is { kind: "line"; text: string } => item.kind === "line")
    .map((item) => item.text);
  const sungRows = lines.filter((row) => !isInaudibleLyricText(row.line));

  const alignedSingable: AlignedLyricLine[] = scriptSingable.map((text, index) => {
    const exact = sungRows.find((row) => row.line === text);
    if (exact) return { ...exact, inaudible: false };
    const byOrder = sungRows[index];
    if (byOrder) return { ...byOrder, line: text, inaudible: false };
    return { line: text, startSec: 0, endSec: 0 };
  });

  return mergeAlignedLyricsWithTags(script, alignedSingable, durationSec);
}

function parseLlmAlignedLines(
  lines: string[],
  durationSec: number,
  content: string,
): AlignedLyricLine[] | null {
  let parsed: { lines?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(content) as { lines?: unknown[] };
  } catch {
    return null;
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

  return fromLlm.length === lines.length ? fromLlm : null;
}

async function alignLyricsWithOpenAiWordRanges(opts: {
  lines: string[];
  words: TranscriptWord[];
  durationSec: number;
  apiKey: string;
  vocalBlocks?: VocalBlock[];
  onProgress?: (note: string) => void;
}): Promise<AlignedLyricLine[]> {
  const { lines, words, durationSec, apiKey, vocalBlocks, onProgress } = opts;
  if (lines.length === 0) return [];
  if (words.length === 0) {
    return alignLyricsFromWordsSingle({ lines, words, durationSec });
  }
  if (words.length > OPENAI_ALIGN_MAX_WORDS) {
    throw new Error(
      `Whisper transcript has ${words.length} words — exceeds the ${OPENAI_ALIGN_MAX_WORDS}-word limit for one AI align request. Try a shorter clip.`,
    );
  }

  const suggested = suggestWordRangesForLines(lines, words);
  const compactWords = words.map((w, i) => ({
    i,
    t: w.word.trim(),
    s: roundSec(w.startSec),
    e: roundSec(w.endSec),
  }));
  const vocalActivity = compactVocalActivity(vocalBlocks);

  const user = JSON.stringify(
    {
      durationSec: roundSec(durationSec),
      lyricLineCount: lines.length,
      transcriptWordCount: words.length,
      vocalActivity,
      lyricLines: lines,
      transcriptWords: compactWords,
      suggestedRanges: suggested.map((range, lineIndex) => ({
        lineIndex,
        wordStart: range.wordStart,
        wordEnd: range.wordEnd,
      })),
      outputSchema: {
        lines: [
          {
            lineIndex: 0,
            wordStart: 0,
            wordEnd: 0,
            confidence: 0.9,
          },
        ],
      },
      task:
        "Align every lyric line to transcriptWords in song order. Use vocalActivity to avoid matching across silence gaps. Return inclusive word index ranges only — timings are derived from those words.",
    },
    null,
    2,
  );

  onProgress?.(
    `Sending ${lines.length} lyric lines and ${words.length} Whisper words to ${OPENAI_LYRIC_ALIGN_MODEL}…`,
  );

  const result = await openAiChatCompletion({
    apiKey,
    model: OPENAI_LYRIC_ALIGN_MODEL,
    temperature: 0,
    jsonMode: true,
    system: LYRIC_ALIGN_SYSTEM,
    user,
  });

  const parsed = parseLlmWordIndexLines(lines.length, words.length, result.content);
  if (parsed) {
    const ranges = enforceWordIndexRanges(
      parsed.map((row) => ({
        wordStart: row.wordStart,
        wordEnd: row.wordEnd,
      })),
    );
    return enforceNonOverlappingAlignedLines(
      alignedLinesFromWordRanges(
        lines,
        words,
        ranges,
        parsed.map((row) => row.confidence),
      ),
      durationSec,
    );
  }

  return alignLyricsFromWordsSingle({ lines, words, durationSec });
}

/** Ask OpenAI to map lyric lines onto Whisper transcript timings. */
export async function alignLyricsWithOpenAi(opts: {
  lines: string[];
  segments: TranscriptSegment[];
  words: TranscriptWord[];
  durationSec: number;
  apiKey: string;
  vocalBlocks?: VocalBlock[];
  onProgress?: (note: string) => void;
}): Promise<AlignedLyricLine[]> {
  const { lines, segments, words, durationSec, apiKey, vocalBlocks, onProgress } =
    opts;
  if (lines.length === 0) throw new Error("Paste lyrics");
  if (words.length === 0 && segments.length === 0) {
    throw new Error(
      "No Whisper transcription — run Align lyrics or Refresh transcription first.",
    );
  }

  if (words.length > 0) {
    return alignLyricsWithOpenAiWordRanges({
      lines,
      words,
      durationSec,
      apiKey,
      vocalBlocks,
      onProgress,
    });
  }

  const user = JSON.stringify(
    {
      durationSec: roundSec(durationSec),
      lyricLines: lines,
      transcriptSegments: segments.map((s) => ({
        text: s.text,
        startSec: roundSec(s.startSec),
        endSec: roundSec(s.endSec),
      })),
      task:
        "No word-level transcript is available. Align each lyric line to segment timings. Lines must be in order with no overlaps: lines[i].endSec equals lines[i+1].startSec.",
      outputSchema: {
        lines: [{ line: "", startSec: 0, endSec: 0, confidence: 0.9 }],
      },
    },
    null,
    2,
  );

  const result = await openAiChatCompletion({
    apiKey,
    model: OPENAI_LYRIC_ALIGN_MODEL,
    temperature: 0,
    jsonMode: true,
    system:
      "You align song lyrics to speech-recognition segment timestamps. Reply with JSON only. Do not overlap lines.",
    user,
  });

  const fromLlm = parseLlmAlignedLines(lines, durationSec, result.content);
  if (fromLlm) {
    return enforceNonOverlappingAlignedLines(fromLlm, durationSec);
  }
  return alignLyricsHeuristic({ lines, segments, durationSec });
}

export async function alignLyricsToTranscript(opts: {
  lines: string[];
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  durationSec: number;
  apiKey: string;
  vocalBlocks?: VocalBlock[];
  onProgress?: (note: string) => void;
}): Promise<AlignedLyricLine[]> {
  const { lines, segments, words, durationSec, apiKey, vocalBlocks, onProgress } =
    opts;
  if (lines.length === 0) throw new Error("Paste lyrics");
  if (words && words.length > 0) {
    return alignLyricsFromWords({ lines, words, durationSec });
  }
  if (segments.length === 0) {
    return alignLyricsHeuristic({ lines, segments, durationSec });
  }

  return alignLyricsWithOpenAi({
    lines,
    segments,
    words: words ?? [],
    durationSec,
    apiKey,
    vocalBlocks,
    onProgress,
  });
}

/** Align singable lines with OpenAI, then restore Suno tags for display. */
export async function alignLyricScriptWithOpenAi(opts: {
  lyricsText: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
  durationSec: number;
  apiKey: string;
  vocalBlocks?: VocalBlock[];
  onProgress?: (note: string) => void;
}): Promise<AlignedLyricLine[]> {
  const script = parseLyricScript(opts.lyricsText);
  const singable = script
    .filter((item): item is { kind: "line"; text: string } => item.kind === "line")
    .map((item) => item.text);
  if (singable.length === 0) {
    throw new Error("Paste singable lyrics (section tags like [Intro] are skipped)");
  }

  const alignedSingable = await alignLyricsWithOpenAi({
    lines: singable,
    segments: opts.segments,
    words: opts.words,
    durationSec: opts.durationSec,
    apiKey: opts.apiKey,
    vocalBlocks: opts.vocalBlocks,
    onProgress: opts.onProgress,
  });

  return mergeAlignedLyricsWithTags(
    script,
    alignedSingable,
    opts.durationSec,
  );
}

/** Align singable lines, then restore Suno tags for display. */
export async function alignLyricScript(opts: {
  lyricsText: string;
  segments: TranscriptSegment[];
  words?: TranscriptWord[];
  durationSec: number;
  apiKey: string;
  vocalBlocks?: VocalBlock[];
}): Promise<AlignedLyricLine[]> {
  const script = parseLyricScript(opts.lyricsText);
  const singable = script
    .filter((item): item is { kind: "line"; text: string } => item.kind === "line")
    .map((item) => item.text);
  if (singable.length === 0) {
    throw new Error("Paste singable lyrics (section tags like [Intro] are skipped)");
  }

  const alignedSingable = await alignLyricsToTranscript({
    lines: singable,
    segments: opts.segments,
    words: opts.words,
    durationSec: opts.durationSec,
    apiKey: opts.apiKey,
    vocalBlocks: opts.vocalBlocks,
  });

  return mergeAlignedLyricsWithTags(script, alignedSingable, opts.durationSec);
}
