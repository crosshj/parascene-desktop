import type {
  LyricAlignment,
  ProjectAspectRatio,
  ProposedScene,
  SceneProductionMethod,
  StoryboardBudget,
  StoryboardConcept,
  StoryboardProposal,
  VisualGroup,
} from "../project/types";
import {
  aspectFramingNote,
  buildLyricStructure,
  compactVocalActivity,
  STORYBOARD_PRODUCTION_AWARENESS,
} from "./storyboardContext";
import { isStoryboardShotType } from "./storyboardShotCatalog";
import { shotCatalogForPayload } from "./storyboardShotCatalog";
import { openAiChatCompletion, OPENAI_STORYBOARD_MODEL } from "./openaiClient";

const MAX_SHOT_SEC = 9;

const SCENE_SYSTEM = `You are a music-video director planning a timed storyboard. Reply with JSON only.

Rules:
- Scenes must tile the full durationSec with no gaps or overlaps.
- Assign every scene a visualGroupId; groups share base assets for reuse.
- Set productionMethod per visual group; minimize unique generations per budget caps.
- Lip-sync (lip_sync_*): prefer a2v_from_still — reuse still, unique a2v per vocal timing.
- B-roll: prefer loop_clip or extend_clip within a group.
- shotType must come from shotCatalog.
- promptHint must stay visually consistent within a visualGroup.
- Do not exceed maxUniqueStills or maxUniqueVideoMasters from budget.`;

function isLipSyncShot(shotType: string): boolean {
  return shotType === "lip_sync_cu" || shotType === "lip_sync_mcu";
}

function sceneOverlapsVocal(
  scene: { startSec: number; endSec: number },
  vocalActivity?: Array<{ startSec: number; endSec: number }>,
): boolean {
  if (!vocalActivity?.length) return true;
  return vocalActivity.some(
    (v) => scene.startSec < v.endSec && scene.endSec > v.startSec,
  );
}

function parseRawProposal(content: string): {
  visualGroups: VisualGroup[];
  scenes: ProposedScene[];
  notes?: string;
  logline?: string;
} | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed) return null;
  const rawGroups = Array.isArray(parsed.visualGroups) ? parsed.visualGroups : [];
  const visualGroups: VisualGroup[] = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== "object") continue;
    const row = g as Record<string, unknown>;
    const id = String(row.id ?? "").trim();
    const label = String(row.label ?? "").trim();
    const basePromptHint = String(row.basePromptHint ?? "").trim();
    const productionMethod = String(row.productionMethod ?? "") as SceneProductionMethod;
    if (!id || !label || !basePromptHint) continue;
    visualGroups.push({
      id,
      label,
      basePromptHint,
      productionMethod,
      masterSceneId:
        typeof row.masterSceneId === "string" ? row.masterSceneId : undefined,
      notes: typeof row.notes === "string" ? row.notes.trim() : undefined,
    });
  }
  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: ProposedScene[] = [];
  for (let i = 0; i < rawScenes.length; i++) {
    const s = rawScenes[i];
    if (!s || typeof s !== "object") continue;
    const row = s as Record<string, unknown>;
    const startSec = Number(row.startSec);
    const endSec = Number(row.endSec);
    const shotType = String(row.shotType ?? "");
    const visualGroupId = String(row.visualGroupId ?? "").trim();
    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      endSec <= startSec ||
      !isStoryboardShotType(shotType) ||
      !visualGroupId
    ) {
      continue;
    }
    const lyricLineIndices = Array.isArray(row.lyricLineIndices)
      ? row.lyricLineIndices
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x) && x >= 0)
      : undefined;
    scenes.push({
      id: String(row.id ?? `scene-${i + 1}`).trim(),
      startSec,
      endSec,
      shotType,
      visualGroupId,
      title: typeof row.title === "string" ? row.title.trim() : undefined,
      note: String(row.note ?? "").trim(),
      promptHint: String(row.promptHint ?? "").trim(),
      lyricLineIndices: lyricLineIndices?.length ? lyricLineIndices : undefined,
      productionMethod:
        typeof row.productionMethod === "string"
          ? (row.productionMethod as SceneProductionMethod)
          : undefined,
      reuseFromSceneId:
        typeof row.reuseFromSceneId === "string"
          ? row.reuseFromSceneId
          : undefined,
    });
  }
  if (!scenes.length) return null;
  return {
    visualGroups,
    scenes,
    notes:
      typeof parsed.notes === "string" ? parsed.notes.trim() : undefined,
    logline:
      typeof parsed.logline === "string" ? parsed.logline.trim() : undefined,
  };
}

function enforceTiling(
  scenes: ProposedScene[],
  durationSec: number,
): ProposedScene[] {
  const sorted = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const out: ProposedScene[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const startSec = i === 0 ? 0 : Math.max(cursor, Number(s.startSec.toFixed(2)));
    let endSec = Number(s.endSec.toFixed(2));
    if (endSec <= startSec) endSec = startSec + 0.5;
    if (i === sorted.length - 1) {
      endSec = durationSec;
    }
    out.push({ ...s, startSec, endSec });
    cursor = endSec;
  }
  if (out.length && out[out.length - 1].endSec < durationSec) {
    out[out.length - 1] = {
      ...out[out.length - 1],
      endSec: durationSec,
    };
  }
  return out;
}

function deriveVocalSlices(
  scenes: ProposedScene[],
  vocalActivity?: Array<{ startSec: number; endSec: number }>,
): ProposedScene[] {
  return scenes.map((scene) => {
    if (!isLipSyncShot(scene.shotType)) return scene;
    const vocalSlice = { inSec: scene.startSec, outSec: scene.endSec };
    const vocalSliceWarning = sceneOverlapsVocal(scene, vocalActivity)
      ? undefined
      : "Scene spans outside detected vocal activity";
    return { ...scene, vocalSlice, vocalSliceWarning };
  });
}

function countUniqueAssets(groups: VisualGroup[]): {
  uniqueStillCount: number;
  uniqueVideoMasterCount: number;
} {
  const stillMethods: SceneProductionMethod[] = [
    "new_still",
    "a2v_from_still",
    "mutate_still",
  ];
  const videoMethods: SceneProductionMethod[] = ["new_video", "reuse_clip"];
  let uniqueStillCount = 0;
  let uniqueVideoMasterCount = 0;
  for (const g of groups) {
    if (stillMethods.includes(g.productionMethod)) uniqueStillCount++;
    if (videoMethods.includes(g.productionMethod)) uniqueVideoMasterCount++;
  }
  return { uniqueStillCount, uniqueVideoMasterCount };
}

export function validateAndFinalizeProposal(
  raw: {
    visualGroups: VisualGroup[];
    scenes: ProposedScene[];
    notes?: string;
    logline?: string;
  },
  opts: {
    durationSec: number;
    budget: StoryboardBudget;
    vocalActivity?: Array<{ startSec: number; endSec: number }>;
  },
): {
  visualGroups: VisualGroup[];
  scenes: ProposedScene[];
  notes?: string;
  logline?: string;
  uniqueStillCount: number;
  uniqueVideoMasterCount: number;
} {
  let scenes = enforceTiling(raw.scenes, opts.durationSec);
  scenes = deriveVocalSlices(scenes, opts.vocalActivity);
  const { uniqueStillCount, uniqueVideoMasterCount } = countUniqueAssets(
    raw.visualGroups,
  );
  return {
    visualGroups: raw.visualGroups,
    scenes,
    notes: raw.notes,
    logline: raw.logline,
    uniqueStillCount,
    uniqueVideoMasterCount,
  };
}

export async function proposeStoryboardScenes(opts: {
  apiKey: string;
  projectTitle: string;
  aspectRatio: ProjectAspectRatio;
  alignment: LyricAlignment;
  lockedConcept: StoryboardConcept;
  budget: StoryboardBudget;
  durationSec: number;
  styleHints?: { still?: string; animate?: string };
  onProgress?: (note: string) => void;
}): Promise<{
  partial: Pick<
    StoryboardProposal,
    | "visualGroups"
    | "scenes"
    | "notes"
    | "logline"
    | "uniqueStillCount"
    | "uniqueVideoMasterCount"
    | "proposedAt"
    | "model"
  >;
  request: Record<string, unknown>;
  response: unknown;
}> {
  const vocalActivity = compactVocalActivity(
    opts.alignment.transcript?.vocalBlocks,
  );
  const user = JSON.stringify(
    {
      durationSec: opts.durationSec,
      aspectRatio: opts.aspectRatio,
      aspectFraming: aspectFramingNote(opts.aspectRatio),
      projectTitle: opts.projectTitle,
      lockedConcept: opts.lockedConcept,
      budget: opts.budget,
      lyricStructure: buildLyricStructure(opts.alignment),
      vocalActivity,
      shotCatalog: shotCatalogForPayload(),
      productionAwareness: STORYBOARD_PRODUCTION_AWARENESS,
      styleHints: opts.styleHints,
      constraints: {
        maxShotSec: MAX_SHOT_SEC,
        preferLipSyncOnVocalLines: true,
      },
      task: "Propose timed music-video scenes for the full song.",
      outputSchema: {
        logline: "",
        notes: "",
        visualGroups: [
          {
            id: "vg-1",
            label: "",
            basePromptHint: "",
            productionMethod: "a2v_from_still",
          },
        ],
        scenes: [
          {
            startSec: 0,
            endSec: 4,
            shotType: "wide_performance",
            visualGroupId: "vg-1",
            note: "",
            promptHint: "",
            lyricLineIndices: [],
          },
        ],
      },
    },
    null,
    2,
  );
  opts.onProgress?.(`Proposing scenes with ${OPENAI_STORYBOARD_MODEL}…`);
  const result = await openAiChatCompletion({
    apiKey: opts.apiKey,
    model: OPENAI_STORYBOARD_MODEL,
    system: SCENE_SYSTEM,
    user,
    jsonMode: true,
    temperature: 0,
  });
  const raw = parseRawProposal(result.content);
  if (!raw) {
    throw new Error("Could not parse storyboard scenes from OpenAI response.");
  }
  const finalized = validateAndFinalizeProposal(raw, {
    durationSec: opts.durationSec,
    budget: opts.budget,
    vocalActivity,
  });
  return {
    partial: {
      ...finalized,
      proposedAt: new Date().toISOString(),
      model: OPENAI_STORYBOARD_MODEL,
    },
    request: result.request,
    response: result.response,
  };
}

export function buildProductionManifest(proposal: StoryboardProposal): Record<
  string,
  unknown
> {
  return {
    lockedConcept: proposal.brainstorm.lockedConcept,
    budget: proposal.budget,
    visualGroups: proposal.visualGroups,
    scenes: proposal.scenes,
    durationSec: proposal.durationSec,
    aspectRatio: proposal.aspectRatio,
  };
}
