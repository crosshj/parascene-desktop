import type {
  BrainstormSession,
  BrainstormTurn,
  LyricAlignment,
  ProjectAspectRatio,
  StoryboardConcept,
  StoryboardConceptOption,
  StoryboardProposal,
} from "../project/types";
import { emptyStoryboardProposal } from "../project/storyboardNormalize";
import {
  aspectFramingNote,
  buildLyricStructure,
  compactVocalActivity,
  songDurationFromAlignment,
  STORYBOARD_PRODUCTION_AWARENESS,
} from "./storyboardContext";
import {
  openAiChatCompletion,
  OPENAI_STORYBOARD_MODEL,
} from "./openaiClient";

export type ManualConceptDraft = {
  title: string;
  logline: string;
  visualApproach: string;
  mood: string;
  tradeoffs?: string;
};

const BRAINSTORM_SYSTEM = `You are a music-video creative director assistant. Reply with JSON only.

Feasibility scores (0–100) reflect PRODUCTION DOABILITY with our pipeline, not creative quality alone:
- 90–100: one setting, 1–2 visual identities, heavy reuse
- 70–89: 2–3 visual modes, moderate lip-sync, disciplined budget
- 50–69: ambitious — many unique setups or poor vocal/instrumental fit
- Below 50: likely impractical for a typical song length

Rules:
- Ground every option in the provided lyrics and section structure.
- Vary visual approach and feasibility profile across options.
- Respect productionAwareness constraints (clip length, a2v, loop/extend).
- creativeDirection / seedPrompt is a suggestion only.`;

const SCORE_SYSTEM = `You score a user-provided music-video concept for production feasibility (0–100). Reply with JSON only.
Use the same feasibility rubric as brainstorm. Do not invent new creative directions.`;

function clampScore(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

function parseOptions(content: string): StoryboardConceptOption[] | null {
  let parsed: { options?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(content) as { options?: unknown[] };
  } catch {
    return null;
  }
  const rows = parsed?.options ?? [];
  const out: StoryboardConceptOption[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const title = String(r.title ?? "").trim();
    const logline = String(r.logline ?? "").trim();
    if (!title || !logline) continue;
    const feasibilityScore = Number(r.feasibilityScore ?? 50);
    out.push({
      id: String(r.id ?? `opt-${i + 1}`).trim(),
      title,
      logline,
      visualApproach: String(r.visualApproach ?? "").trim(),
      mood: String(r.mood ?? "").trim(),
      feasibilityScore: clampScore(feasibilityScore),
      feasibilityRationale: String(r.feasibilityRationale ?? "").trim(),
      tradeoffs: String(r.tradeoffs ?? "").trim(),
    });
  }
  return out.length ? out : null;
}

function parseRefinedOption(content: string): StoryboardConceptOption | null {
  let parsed: { option?: unknown } | null = null;
  try {
    parsed = JSON.parse(content) as { option?: unknown };
  } catch {
    return null;
  }
  const row = parsed?.option;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const title = String(r.title ?? "").trim();
  if (!title) return null;
  return {
    id: String(r.id ?? "opt-refined").trim(),
    title,
    logline: String(r.logline ?? "").trim(),
    visualApproach: String(r.visualApproach ?? "").trim(),
    mood: String(r.mood ?? "").trim(),
    feasibilityScore: clampScore(Number(r.feasibilityScore ?? 50)),
    feasibilityRationale: String(r.feasibilityRationale ?? "").trim(),
    tradeoffs: String(r.tradeoffs ?? "").trim(),
  };
}

function parseScore(content: string): {
  feasibilityScore: number;
  feasibilityRationale: string;
  tradeoffs?: string;
} | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;
  const feasibilityScore = Number(parsed.feasibilityScore);
  if (!Number.isFinite(feasibilityScore)) return null;
  return {
    feasibilityScore: clampScore(feasibilityScore),
    feasibilityRationale: String(parsed.feasibilityRationale ?? "").trim(),
    tradeoffs:
      typeof parsed.tradeoffs === "string" ? parsed.tradeoffs.trim() : undefined,
  };
}

function basePayload(opts: {
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  seedPrompt?: string;
  styleHints?: { still?: string; animate?: string };
}) {
  const durationSec = songDurationFromAlignment(opts.alignment);
  return {
    durationSec,
    aspectRatio: opts.aspectRatio,
    aspectFraming: aspectFramingNote(opts.aspectRatio),
    projectTitle: opts.projectTitle,
    seedPrompt: opts.seedPrompt?.trim() || undefined,
    lyricStructure: buildLyricStructure(opts.alignment),
    vocalActivity: compactVocalActivity(
      opts.alignment.transcript?.vocalBlocks,
    ),
    productionAwareness: STORYBOARD_PRODUCTION_AWARENESS,
    styleHints: opts.styleHints,
  };
}

export function lockStoryboardConcept(input: {
  source: "brainstorm" | "manual";
  option: StoryboardConceptOption | (ManualConceptDraft & {
    feasibilityScore: number;
    feasibilityRationale: string;
    tradeoffs: string;
    optionId?: string;
  });
}): StoryboardConcept {
  const o = input.option;
  return {
    lockedAt: new Date().toISOString(),
    source: input.source,
    optionId:
      "id" in o && o.id
        ? o.id
        : input.source === "manual"
          ? "manual"
          : "unknown",
    title: o.title.trim(),
    logline: o.logline.trim(),
    visualApproach: o.visualApproach.trim(),
    mood: o.mood.trim(),
    feasibilityScore: clampScore(o.feasibilityScore),
    feasibilityRationale: o.feasibilityRationale.trim(),
    tradeoffs: (o.tradeoffs ?? "").trim(),
  };
}

export async function generateStoryboardConceptOptions(opts: {
  apiKey: string;
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  seedPrompt?: string;
  styleHints?: { still?: string; animate?: string };
  onProgress?: (note: string) => void;
}): Promise<{
  options: StoryboardConceptOption[];
  request: Record<string, unknown>;
  response: unknown;
}> {
  const user = JSON.stringify(
    {
      ...basePayload(opts),
      task: "Propose 3–5 distinct music-video concept options.",
      outputSchema: {
        options: [
          {
            id: "opt-1",
            title: "",
            logline: "",
            visualApproach: "",
            mood: "",
            feasibilityScore: 75,
            feasibilityRationale: "",
            tradeoffs: "",
          },
        ],
      },
    },
    null,
    2,
  );
  opts.onProgress?.(`Brainstorming concepts with ${OPENAI_STORYBOARD_MODEL}…`);
  const result = await openAiChatCompletion({
    apiKey: opts.apiKey,
    model: OPENAI_STORYBOARD_MODEL,
    system: BRAINSTORM_SYSTEM,
    user,
    jsonMode: true,
    temperature: 0.7,
  });
  const options = parseOptions(result.content);
  if (!options) {
    throw new Error("Could not parse concept options from OpenAI response.");
  }
  return { options, request: result.request, response: result.response };
}

export async function refineStoryboardConceptOption(opts: {
  apiKey: string;
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  seedPrompt?: string;
  styleHints?: { still?: string; animate?: string };
  selectedOption: StoryboardConceptOption;
  userFeedback: string;
  priorTurnsSummary?: string;
  onProgress?: (note: string) => void;
}): Promise<{
  option: StoryboardConceptOption;
  request: Record<string, unknown>;
  response: unknown;
}> {
  const user = JSON.stringify(
    {
      ...basePayload(opts),
      selectedOption: opts.selectedOption,
      userFeedback: opts.userFeedback.trim(),
      priorTurnsSummary: opts.priorTurnsSummary,
      task: "Revise the selected option per user feedback. Re-score feasibility.",
      outputSchema: {
        option: {
          id: opts.selectedOption.id,
          title: "",
          logline: "",
          visualApproach: "",
          mood: "",
          feasibilityScore: 75,
          feasibilityRationale: "",
          tradeoffs: "",
        },
      },
    },
    null,
    2,
  );
  opts.onProgress?.("Refining concept…");
  const result = await openAiChatCompletion({
    apiKey: opts.apiKey,
    model: OPENAI_STORYBOARD_MODEL,
    system: BRAINSTORM_SYSTEM,
    user,
    jsonMode: true,
    temperature: 0.6,
  });
  const option = parseRefinedOption(result.content);
  if (!option) {
    throw new Error("Could not parse refined concept from OpenAI response.");
  }
  return { option, request: result.request, response: result.response };
}

export async function scoreManualStoryboardConcept(opts: {
  apiKey: string;
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  draft: ManualConceptDraft;
  styleHints?: { still?: string; animate?: string };
  onProgress?: (note: string) => void;
}): Promise<{
  score: { feasibilityScore: number; feasibilityRationale: string; tradeoffs: string };
  request: Record<string, unknown>;
  response: unknown;
}> {
  const user = JSON.stringify(
    {
      ...basePayload(opts),
      concept: opts.draft,
      task: "Score this concept only. Return feasibilityScore, feasibilityRationale, tradeoffs.",
      outputSchema: {
        feasibilityScore: 75,
        feasibilityRationale: "",
        tradeoffs: "",
      },
    },
    null,
    2,
  );
  opts.onProgress?.("Scoring feasibility of your concept…");
  const result = await openAiChatCompletion({
    apiKey: opts.apiKey,
    model: OPENAI_STORYBOARD_MODEL,
    system: SCORE_SYSTEM,
    user,
    jsonMode: true,
    temperature: 0,
  });
  const parsed = parseScore(result.content);
  if (!parsed) {
    throw new Error("Could not parse feasibility score from OpenAI response.");
  }
  return {
    score: {
      feasibilityScore: parsed.feasibilityScore,
      feasibilityRationale: parsed.feasibilityRationale,
      tradeoffs: parsed.tradeoffs ?? opts.draft.tradeoffs?.trim() ?? "",
    },
    request: result.request,
    response: result.response,
  };
}

export function appendBrainstormTurn(
  session: BrainstormSession,
  turn: Omit<BrainstormTurn, "at">,
): BrainstormSession {
  return {
    ...session,
    turns: [
      ...session.turns,
      { ...turn, at: new Date().toISOString() },
    ],
  };
}

export function ensureStoryboardProposal(
  current: StoryboardProposal | null,
  opts: {
    sourceAudioCreationId: string;
    durationSec: number;
    aspectRatio: ProjectAspectRatio;
    seedPrompt?: string;
  },
): StoryboardProposal {
  if (
    current &&
    current.sourceAudioCreationId === opts.sourceAudioCreationId
  ) {
    return current;
  }
  return emptyStoryboardProposal(opts);
}

export function applyLockedConcept(
  proposal: StoryboardProposal,
  concept: StoryboardConcept,
): StoryboardProposal {
  return {
    ...proposal,
    brainstorm: {
      ...proposal.brainstorm,
      lockedConcept: concept,
    },
    logline: concept.logline,
  };
}
