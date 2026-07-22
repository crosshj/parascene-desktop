import { isProjectAspectRatio, DEFAULT_PROJECT_ASPECT_RATIO } from "./aspectRatios";
import type {
  BrainstormSession,
  BrainstormTurn,
  GenerationStepKind,
  GenerationStepStatus,
  ProposedScene,
  SceneProductionMethod,
  StoryboardBudget,
  StoryboardConcept,
  StoryboardConceptOption,
  StoryboardGenerationPlan,
  StoryboardGenerationStep,
  StoryboardProposal,
  StoryboardShotType,
  VideoStillSource,
  VideoStillSourceMode,
  VisualGroup,
} from "./types";
import { isStoryboardShotType } from "../lab/storyboardShotCatalog";

const PRODUCTION_METHODS: SceneProductionMethod[] = [
  "new_still",
  "new_video",
  "a2v_from_still",
  "loop_clip",
  "extend_clip",
  "mutate_still",
  "lyric_card",
  "reuse_clip",
];

const GENERATION_STEP_KINDS: GenerationStepKind[] = [
  "create_still",
  "create_video",
  "a2v",
  "pull_frame",
  "place_clip",
  "noop",
];

const GENERATION_STEP_STATUSES: GenerationStepStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
];

function isGenerationStepKind(value: unknown): value is GenerationStepKind {
  return (
    typeof value === "string" &&
    (GENERATION_STEP_KINDS as readonly string[]).includes(value)
  );
}

function isGenerationStepStatus(value: unknown): value is GenerationStepStatus {
  return (
    typeof value === "string" &&
    (GENERATION_STEP_STATUSES as readonly string[]).includes(value)
  );
}

const VIDEO_STILL_SOURCE_MODES: VideoStillSourceMode[] = [
  "prompt_only",
  "previous_video_frame",
  "group_still",
  "project_image",
];

function isVideoStillSourceMode(value: unknown): value is VideoStillSourceMode {
  return (
    typeof value === "string" &&
    (VIDEO_STILL_SOURCE_MODES as readonly string[]).includes(value)
  );
}

function normalizeVideoStillSource(value: unknown): VideoStillSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!isVideoStillSourceMode(row.mode)) return undefined;
  return {
    mode: row.mode,
    stillStepId:
      typeof row.stillStepId === "string" ? row.stillStepId : undefined,
    creationId:
      typeof row.creationId === "string" && row.creationId.trim()
        ? row.creationId.trim()
        : undefined,
  };
}

function normalizeGenerationStep(value: unknown): StoryboardGenerationStep | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (!isGenerationStepKind(row.kind)) return null;
  if (typeof row.label !== "string") return null;
  if (!isGenerationStepStatus(row.status)) return null;
  const dependsOn = Array.isArray(row.dependsOn)
    ? row.dependsOn.filter((d): d is string => typeof d === "string")
    : [];
  const vocalSlice =
    row.vocalSlice && typeof row.vocalSlice === "object"
      ? (() => {
          const v = row.vocalSlice as Record<string, unknown>;
          const inSec = Number(v.inSec);
          const outSec = Number(v.outSec);
          if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec) {
            return undefined;
          }
          return { inSec, outSec };
        })()
      : undefined;
  return {
    id: row.id.trim(),
    kind: row.kind,
    label: row.label.trim(),
    sceneId: typeof row.sceneId === "string" ? row.sceneId : undefined,
    visualGroupId:
      typeof row.visualGroupId === "string" ? row.visualGroupId : undefined,
    status: row.status,
    creationId:
      typeof row.creationId === "string" && row.creationId.trim()
        ? row.creationId.trim()
        : undefined,
    dependsOn,
    prompt: typeof row.prompt === "string" ? row.prompt : undefined,
    vocalSlice,
    stillStepId:
      typeof row.stillStepId === "string" ? row.stillStepId : undefined,
    sourceStepId:
      typeof row.sourceStepId === "string" ? row.sourceStepId : undefined,
    stillSource: normalizeVideoStillSource(row.stillSource),
    error: typeof row.error === "string" ? row.error : undefined,
    completedAt:
      typeof row.completedAt === "string" ? row.completedAt : undefined,
  };
}

function normalizeGenerationPlan(value: unknown): StoryboardGenerationPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.builtAt !== "string" || !row.builtAt.trim()) return undefined;
  if (typeof row.proposalFingerprint !== "string") return undefined;
  const steps = Array.isArray(row.steps)
    ? row.steps
        .map(normalizeGenerationStep)
        .filter((s): s is StoryboardGenerationStep => s !== null)
    : [];
  return {
    builtAt: row.builtAt.trim(),
    proposalFingerprint: row.proposalFingerprint,
    steps,
  };
}

function isProductionMethod(value: unknown): value is SceneProductionMethod {
  return (
    typeof value === "string" &&
    (PRODUCTION_METHODS as readonly string[]).includes(value)
  );
}

function clampScore(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normalizeConceptOption(value: unknown): StoryboardConceptOption | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  if (typeof row.logline !== "string") return null;
  if (typeof row.visualApproach !== "string") return null;
  if (typeof row.mood !== "string") return null;
  const feasibilityScore = Number(row.feasibilityScore);
  if (!Number.isFinite(feasibilityScore)) return null;
  if (typeof row.feasibilityRationale !== "string") return null;
  if (typeof row.tradeoffs !== "string") return null;
  return {
    id: row.id.trim(),
    title: row.title.trim(),
    logline: row.logline.trim(),
    visualApproach: row.visualApproach.trim(),
    mood: row.mood.trim(),
    feasibilityScore: clampScore(feasibilityScore),
    feasibilityRationale: row.feasibilityRationale.trim(),
    tradeoffs: row.tradeoffs.trim(),
  };
}

function normalizeStoryboardConcept(value: unknown): StoryboardConcept | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.source !== "brainstorm" && row.source !== "manual") return null;
  if (typeof row.lockedAt !== "string" || !row.lockedAt.trim()) return null;
  if (typeof row.optionId !== "string" || !row.optionId.trim()) return null;
  if (typeof row.title !== "string" || !row.title.trim()) return null;
  if (typeof row.logline !== "string") return null;
  if (typeof row.visualApproach !== "string") return null;
  if (typeof row.mood !== "string") return null;
  const feasibilityScore = Number(row.feasibilityScore);
  if (!Number.isFinite(feasibilityScore)) return null;
  if (typeof row.feasibilityRationale !== "string") return null;
  if (typeof row.tradeoffs !== "string") return null;
  return {
    lockedAt: row.lockedAt.trim(),
    source: row.source,
    optionId: row.optionId.trim(),
    title: row.title.trim(),
    logline: row.logline.trim(),
    visualApproach: row.visualApproach.trim(),
    mood: row.mood.trim(),
    feasibilityScore: clampScore(feasibilityScore),
    feasibilityRationale: row.feasibilityRationale.trim(),
    tradeoffs: row.tradeoffs.trim(),
    userNotes:
      typeof row.userNotes === "string" && row.userNotes.trim()
        ? row.userNotes.trim()
        : undefined,
  };
}

function normalizeBrainstormTurn(value: unknown): BrainstormTurn | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.at !== "string" || !row.at.trim()) return null;
  if (row.kind !== "options" && row.kind !== "refine" && row.kind !== "user") {
    return null;
  }
  const options = Array.isArray(row.options)
    ? row.options
        .map(normalizeConceptOption)
        .filter((o): o is StoryboardConceptOption => o !== null)
    : undefined;
  const refinedOption = row.refinedOption
    ? normalizeConceptOption(row.refinedOption)
    : undefined;
  return {
    at: row.at.trim(),
    kind: row.kind,
    userMessage:
      typeof row.userMessage === "string" ? row.userMessage : undefined,
    options: options?.length ? options : undefined,
    refinedOption: refinedOption ?? undefined,
    parentOptionId:
      typeof row.parentOptionId === "string" ? row.parentOptionId : undefined,
  };
}

function normalizeBrainstormSession(value: unknown): BrainstormSession {
  if (!value || typeof value !== "object") {
    return { startedAt: new Date().toISOString(), turns: [] };
  }
  const row = value as Record<string, unknown>;
  const turns = Array.isArray(row.turns)
    ? row.turns
        .map(normalizeBrainstormTurn)
        .filter((t): t is BrainstormTurn => t !== null)
    : [];
  const lockedConcept = row.lockedConcept
    ? normalizeStoryboardConcept(row.lockedConcept)
    : undefined;
  return {
    startedAt:
      typeof row.startedAt === "string" && row.startedAt.trim()
        ? row.startedAt.trim()
        : new Date().toISOString(),
    seedPrompt:
      typeof row.seedPrompt === "string" && row.seedPrompt.trim()
        ? row.seedPrompt.trim()
        : undefined,
    turns,
    lockedConcept: lockedConcept ?? undefined,
  };
}

function normalizeStoryboardBudget(value: unknown): StoryboardBudget | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.plannedAt !== "string" || !row.plannedAt.trim()) return null;
  if (typeof row.model !== "string" || !row.model.trim()) return null;
  const durationSec = Number(row.durationSec);
  const maxUniqueStills = Number(row.maxUniqueStills);
  const maxUniqueVideoMasters = Number(row.maxUniqueVideoMasters);
  const targetSceneCount = Number(row.targetSceneCount);
  if (
    !Number.isFinite(durationSec) ||
    !Number.isFinite(maxUniqueStills) ||
    !Number.isFinite(maxUniqueVideoMasters) ||
    !Number.isFinite(targetSceneCount)
  ) {
    return null;
  }
  if (typeof row.reuseStrategy !== "string") return null;
  const sectionNotes = Array.isArray(row.sectionNotes)
    ? row.sectionNotes
        .map((note) => {
          if (!note || typeof note !== "object") return null;
          const n = note as Record<string, unknown>;
          const startSec = Number(n.startSec);
          const endSec = Number(n.endSec);
          if (typeof n.tag !== "string" || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
            return null;
          }
          if (typeof n.note !== "string") return null;
          return {
            tag: n.tag,
            startSec,
            endSec,
            note: n.note.trim(),
          };
        })
        .filter((n): n is NonNullable<typeof n> => n !== null)
    : undefined;
  return {
    plannedAt: row.plannedAt.trim(),
    model: row.model.trim(),
    durationSec,
    maxUniqueStills: Math.max(0, Math.round(maxUniqueStills)),
    maxUniqueVideoMasters: Math.max(0, Math.round(maxUniqueVideoMasters)),
    targetSceneCount: Math.max(1, Math.round(targetSceneCount)),
    reuseStrategy: row.reuseStrategy.trim(),
    sectionNotes: sectionNotes?.length ? sectionNotes : undefined,
  };
}

function normalizeVisualGroup(value: unknown): VisualGroup | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.label !== "string" || !row.label.trim()) return null;
  if (typeof row.basePromptHint !== "string") return null;
  if (!isProductionMethod(row.productionMethod)) return null;
  return {
    id: row.id.trim(),
    label: row.label.trim(),
    basePromptHint: row.basePromptHint.trim(),
    productionMethod: row.productionMethod,
    masterSceneId:
      typeof row.masterSceneId === "string" ? row.masterSceneId : undefined,
    notes: typeof row.notes === "string" ? row.notes.trim() : undefined,
  };
}

function normalizeProposedScene(value: unknown): ProposedScene | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  const startSec = Number(row.startSec);
  const endSec = Number(row.endSec);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }
  if (!isStoryboardShotType(row.shotType)) return null;
  if (typeof row.visualGroupId !== "string" || !row.visualGroupId.trim()) {
    return null;
  }
  if (typeof row.note !== "string") return null;
  if (typeof row.promptHint !== "string") return null;
  const lyricLineIndices = Array.isArray(row.lyricLineIndices)
    ? row.lyricLineIndices
        .map((i) => Number(i))
        .filter((i) => Number.isFinite(i) && i >= 0)
    : undefined;
  const vocalSlice =
    row.vocalSlice && typeof row.vocalSlice === "object"
      ? (() => {
          const v = row.vocalSlice as Record<string, unknown>;
          const inSec = Number(v.inSec);
          const outSec = Number(v.outSec);
          if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec) {
            return undefined;
          }
          return { inSec, outSec };
        })()
      : undefined;
  return {
    id: row.id.trim(),
    startSec,
    endSec,
    shotType: row.shotType as StoryboardShotType,
    visualGroupId: row.visualGroupId.trim(),
    title: typeof row.title === "string" ? row.title.trim() : undefined,
    note: row.note.trim(),
    promptHint: row.promptHint.trim(),
    lyricLineIndices: lyricLineIndices?.length ? lyricLineIndices : undefined,
    productionMethod: isProductionMethod(row.productionMethod)
      ? row.productionMethod
      : undefined,
    reuseFromSceneId:
      typeof row.reuseFromSceneId === "string"
        ? row.reuseFromSceneId
        : undefined,
    vocalSlice,
    vocalSliceWarning:
      typeof row.vocalSliceWarning === "string"
        ? row.vocalSliceWarning.trim()
        : undefined,
  };
}

export function normalizeStoryboardProposal(value: unknown): StoryboardProposal | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const sourceAudioCreationId =
    typeof row.sourceAudioCreationId === "string" && row.sourceAudioCreationId.trim()
      ? row.sourceAudioCreationId.trim()
      : null;
  if (!sourceAudioCreationId) return null;
  const durationSec = Number(row.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const aspectRatio = isProjectAspectRatio(row.aspectRatio)
    ? row.aspectRatio
    : DEFAULT_PROJECT_ASPECT_RATIO;
  const brainstorm = normalizeBrainstormSession(row.brainstorm);
  const budget = row.budget ? normalizeStoryboardBudget(row.budget) : undefined;
  const visualGroups = Array.isArray(row.visualGroups)
    ? row.visualGroups
        .map(normalizeVisualGroup)
        .filter((g): g is VisualGroup => g !== null)
    : [];
  const scenes = Array.isArray(row.scenes)
    ? row.scenes
        .map(normalizeProposedScene)
        .filter((s): s is ProposedScene => s !== null)
    : [];
  const uniqueStillCount = Number(row.uniqueStillCount);
  const uniqueVideoMasterCount = Number(row.uniqueVideoMasterCount);
  return {
    sourceAudioCreationId,
    durationSec,
    aspectRatio,
    brainstorm,
    budget: budget ?? undefined,
    proposedAt:
      typeof row.proposedAt === "string" && row.proposedAt.trim()
        ? row.proposedAt.trim()
        : undefined,
    model:
      typeof row.model === "string" && row.model.trim()
        ? row.model.trim()
        : undefined,
    logline:
      typeof row.logline === "string" && row.logline.trim()
        ? row.logline.trim()
        : undefined,
    visualGroups,
    scenes,
    notes:
      typeof row.notes === "string" && row.notes.trim()
        ? row.notes.trim()
        : undefined,
    uniqueStillCount: Number.isFinite(uniqueStillCount)
      ? uniqueStillCount
      : undefined,
    uniqueVideoMasterCount: Number.isFinite(uniqueVideoMasterCount)
      ? uniqueVideoMasterCount
      : undefined,
    generationPlan: normalizeGenerationPlan(row.generationPlan),
  };
}

export function emptyStoryboardProposal(opts: {
  sourceAudioCreationId: string;
  durationSec: number;
  aspectRatio: StoryboardProposal["aspectRatio"];
  seedPrompt?: string;
}): StoryboardProposal {
  return {
    sourceAudioCreationId: opts.sourceAudioCreationId,
    durationSec: opts.durationSec,
    aspectRatio: opts.aspectRatio,
    brainstorm: {
      startedAt: new Date().toISOString(),
      seedPrompt: opts.seedPrompt,
      turns: [],
    },
    visualGroups: [],
    scenes: [],
  };
}

export function hasLockedStoryboardConcept(
  proposal: StoryboardProposal | null | undefined,
): boolean {
  return Boolean(proposal?.brainstorm?.lockedConcept);
}

export function hasStoryboardBudget(
  proposal: StoryboardProposal | null | undefined,
): boolean {
  return Boolean(proposal?.budget);
}

export function hasStoryboardScenes(
  proposal: StoryboardProposal | null | undefined,
): boolean {
  return Boolean(proposal?.scenes?.length);
}
