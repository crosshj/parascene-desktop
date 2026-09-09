/**
 * Curated Replicate speech / music models (not Lab Enable).
 * Fetch schema via crawl cache, then replicateModelFetchFull if the slug missed.
 */

import {
  parseReplicateOwnerName,
  replicateModelFetchFull,
  replicateModelGet,
  type ReplicateInputField,
  type ReplicateModelDetail,
} from "../../replicate/replicateClient";
import type { GenerateIntentId } from "./previewIntent";

export const REPLICATE_VOICE_CLONE_SLUG = "minimax/voice-cloning";
export const REPLICATE_VOICE_CLONE_MODEL = "speech-02-hd";

export type CuratedAudioModelId =
  | "minimax/speech-2.8-turbo"
  | "google/gemini-3.1-flash-tts"
  | "google/lyria-3"
  | "minimax/music-2.6";

export type CuratedAudioModelDef = {
  id: CuratedAudioModelId;
  intentId: Extract<GenerateIntentId, "text_to_speech" | "text_to_music">;
  label: string;
  hint: string;
  /** Big text box maps here. */
  textField: "text" | "prompt";
};

export const CURATED_REPLICATE_AUDIO_MODELS: readonly CuratedAudioModelDef[] = [
  {
    id: "minimax/speech-2.8-turbo",
    intentId: "text_to_speech",
    label: "MiniMax Speech 2.8 Turbo",
    hint: "Narration",
    textField: "text",
  },
  {
    id: "google/gemini-3.1-flash-tts",
    intentId: "text_to_speech",
    label: "Gemini 3.1 Flash TTS",
    hint: "Narration / replacement line",
    textField: "text",
  },
  {
    id: "google/lyria-3",
    intentId: "text_to_music",
    label: "Lyria 3",
    hint: "Dramatic background score · 30s",
    textField: "prompt",
  },
  {
    id: "minimax/music-2.6",
    intentId: "text_to_music",
    label: "MiniMax Music 2.6",
    hint: "Song / MV track",
    textField: "prompt",
  },
];

export type ReplicateAudioModelOption = CuratedAudioModelDef & {
  owner: string;
  name: string;
  inputs: ReplicateInputField[];
};

export function curatedAudioModelsForIntent(
  intentId: "text_to_speech" | "text_to_music",
): CuratedAudioModelDef[] {
  return CURATED_REPLICATE_AUDIO_MODELS.filter((m) => m.intentId === intentId);
}

export function findCuratedAudioModel(
  id: string | null | undefined,
): CuratedAudioModelDef | null {
  const slug = id?.trim();
  if (!slug) return null;
  return CURATED_REPLICATE_AUDIO_MODELS.find((m) => m.id === slug) ?? null;
}

/** Match a stored / labeled model onto a curated row (Gemini labels used to miss). */
export function pickCuratedAudioModelId(
  rows: readonly { id: string }[],
  current: string | null | undefined,
  seeded?: string | null,
): string | null {
  const ids = rows.map((row) => row.id);
  const seed = seeded?.trim() || "";
  // Prefer the clone/review seed so a MiniMax default does not win on reload.
  if (seed && ids.includes(seed)) return seed;
  if (current && ids.includes(current)) return current;
  return (
    matchCuratedAudioModelId(seed, ids) ??
    matchCuratedAudioModelId(current, ids) ??
    rows[0]?.id ??
    null
  );
}

function matchCuratedAudioModelId(
  raw: string | null | undefined,
  ids: readonly string[],
): string | undefined {
  const needle = raw?.trim().toLowerCase() ?? "";
  if (!needle) return undefined;
  const exact = ids.find(
    (id) =>
      id.toLowerCase() === needle ||
      id.toLowerCase().includes(needle) ||
      needle.includes(id.toLowerCase()),
  );
  if (exact) return exact;
  if (/gemini/.test(needle)) return ids.find((id) => /gemini/i.test(id));
  if (/lyria/.test(needle)) return ids.find((id) => /lyria/i.test(id));
  if (/music/.test(needle)) return ids.find((id) => /music/i.test(id));
  if (/speech|minimax/.test(needle)) {
    return ids.find((id) => /speech/i.test(id));
  }
  return undefined;
}

async function loadModelDetail(
  owner: string,
  name: string,
): Promise<ReplicateModelDetail | null> {
  try {
    const cached = await replicateModelGet(owner, name);
    if (cached?.schemaCached && cached.inputs?.length) return cached;
  } catch {
    /* crawl miss */
  }
  try {
    return await replicateModelFetchFull(owner, name);
  } catch {
    return null;
  }
}

export async function loadCuratedReplicateAudioModels(
  intentId: "text_to_speech" | "text_to_music",
): Promise<ReplicateAudioModelOption[]> {
  const defs = curatedAudioModelsForIntent(intentId);
  const loaded = await Promise.all(
    defs.map(async (def) => {
      const slug = parseReplicateOwnerName(def.id);
      if (!slug) return null;
      const detail = await loadModelDetail(slug.owner, slug.name);
      return {
        ...def,
        owner: slug.owner,
        name: slug.name,
        inputs: detail?.inputs ?? [],
      } satisfies ReplicateAudioModelOption;
    }),
  );
  return loaded.filter((row): row is ReplicateAudioModelOption => row != null);
}

export async function loadVoiceCloneModelInputs(): Promise<ReplicateInputField[]> {
  const slug = parseReplicateOwnerName(REPLICATE_VOICE_CLONE_SLUG);
  if (!slug) return [];
  const detail = await loadModelDetail(slug.owner, slug.name);
  return detail?.inputs ?? [];
}
