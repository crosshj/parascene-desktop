import type {
  LyricAlignment,
  ProjectAspectRatio,
  StoryboardBudget,
  StoryboardConcept,
} from "../project/types";
import {
  aspectFramingNote,
  buildLyricStructure,
  compactVocalActivity,
  songDurationFromAlignment,
  STORYBOARD_PRODUCTION_AWARENESS,
} from "./storyboardContext";
import { openAiChatCompletion, OPENAI_STORYBOARD_MODEL } from "./openaiClient";

const BUDGET_SYSTEM = `You are a music-video production planner. Reply with JSON only.

Recommend a realistic generation budget for the locked creative concept.
Honor production constraints. Minimize unique generations while serving the concept.

Return ONE flat JSON object at the top level (do not nest under "budget" or "output") with:
- maxUniqueStills (number)
- maxUniqueVideoMasters (number)
- targetSceneCount (number)
- reuseStrategy (string)
- sectionNotes (optional array of { tag, startSec, endSec, note })`;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pickNumber(row: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const n = Number(row[key]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function unwrapBudgetPayload(parsed: Record<string, unknown>): Record<string, unknown> {
  const hasBudgetFields = (row: Record<string, unknown>) =>
    Number.isFinite(pickNumber(row, "maxUniqueStills", "max_unique_stills")) ||
    Number.isFinite(
      pickNumber(row, "maxUniqueVideoMasters", "max_unique_video_masters"),
    ) ||
    Number.isFinite(pickNumber(row, "targetSceneCount", "target_scene_count"));

  if (hasBudgetFields(parsed)) return parsed;

  for (const key of [
    "budget",
    "generationBudget",
    "storyboardBudget",
    "output",
    "result",
    "plan",
  ]) {
    const nested = asRecord(parsed[key]);
    if (nested && hasBudgetFields(nested)) return nested;
  }
  return parsed;
}

export function parseBudget(
  content: string,
  durationSec: number,
): StoryboardBudget | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;
  const row = unwrapBudgetPayload(parsed);

  const maxUniqueStills = pickNumber(
    row,
    "maxUniqueStills",
    "max_unique_stills",
    "uniqueStills",
  );
  const maxUniqueVideoMasters = pickNumber(
    row,
    "maxUniqueVideoMasters",
    "max_unique_video_masters",
    "maxUniqueVideos",
    "uniqueVideoMasters",
  );
  const targetSceneCount = pickNumber(
    row,
    "targetSceneCount",
    "target_scene_count",
    "sceneCount",
  );
  if (
    !Number.isFinite(maxUniqueStills) ||
    !Number.isFinite(maxUniqueVideoMasters) ||
    !Number.isFinite(targetSceneCount)
  ) {
    return null;
  }

  const reuseStrategy = pickString(
    row,
    "reuseStrategy",
    "reuse_strategy",
    "strategy",
    "reusePlan",
  );
  if (!reuseStrategy) return null;

  const rawNotes = row.sectionNotes ?? row.section_notes;
  const sectionNotes = Array.isArray(rawNotes)
    ? rawNotes
        .map((note) => {
          if (!note || typeof note !== "object") return null;
          const n = note as Record<string, unknown>;
          const startSec = Number(n.startSec ?? n.start_sec);
          const endSec = Number(n.endSec ?? n.end_sec);
          const tag = pickString(n, "tag", "section", "label");
          const noteText = pickString(n, "note", "notes", "description");
          if (!tag || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
            return null;
          }
          return {
            tag,
            startSec,
            endSec,
            note: noteText,
          };
        })
        .filter((n): n is NonNullable<typeof n> => n !== null)
    : undefined;

  return {
    plannedAt: new Date().toISOString(),
    model: OPENAI_STORYBOARD_MODEL,
    durationSec,
    maxUniqueStills: Math.max(1, Math.round(maxUniqueStills)),
    maxUniqueVideoMasters: Math.max(1, Math.round(maxUniqueVideoMasters)),
    targetSceneCount: Math.max(1, Math.round(targetSceneCount)),
    reuseStrategy,
    sectionNotes: sectionNotes?.length ? sectionNotes : undefined,
  };
}

export async function planStoryboardBudget(opts: {
  apiKey: string;
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  lockedConcept: StoryboardConcept;
  styleHints?: { still?: string; animate?: string };
  onProgress?: (note: string) => void;
}): Promise<{
  budget: StoryboardBudget;
  request: Record<string, unknown>;
  response: unknown;
}> {
  const durationSec = songDurationFromAlignment(opts.alignment);
  const user = JSON.stringify(
    {
      durationSec,
      aspectRatio: opts.aspectRatio,
      aspectFraming: aspectFramingNote(opts.aspectRatio),
      projectTitle: opts.projectTitle,
      lockedConcept: opts.lockedConcept,
      lyricStructure: buildLyricStructure(opts.alignment),
      vocalActivity: compactVocalActivity(
        opts.alignment.transcript?.vocalBlocks,
      ),
      productionAwareness: STORYBOARD_PRODUCTION_AWARENESS,
      styleHints: opts.styleHints,
      task: "Plan generation budget caps and reuse strategy for the full song.",
      outputSchema: {
        maxUniqueStills: 4,
        maxUniqueVideoMasters: 3,
        targetSceneCount: 18,
        reuseStrategy: "",
        sectionNotes: [
          { tag: "[Intro]", startSec: 0, endSec: 12, note: "" },
        ],
      },
    },
    null,
    2,
  );
  opts.onProgress?.(`Planning budget with ${OPENAI_STORYBOARD_MODEL}…`);
  const result = await openAiChatCompletion({
    apiKey: opts.apiKey,
    model: OPENAI_STORYBOARD_MODEL,
    system: BUDGET_SYSTEM,
    user,
    jsonMode: true,
    temperature: 0,
  });
  const budget = parseBudget(result.content, durationSec);
  if (!budget) {
    throw new Error("Could not parse budget from OpenAI response.");
  }
  return { budget, request: result.request, response: result.response };
}
