import type {
  ProposedScene,
  SceneProductionMethod,
  StoryboardGenerationPlan,
  StoryboardGenerationStep,
  StoryboardProposal,
  VideoStillSource,
  VisualGroup,
} from "../project/types";
import { LAB_A2V_PROMPT, resolveLabAnimatePrompt, resolveLabStillPrompt } from "./labPrompts";

export type BuildStyleHints = {
  still: string;
  animate: string;
};

function stepId(kind: string, key: string): string {
  return `${kind}:${key}`;
}

export function isVideoGenStep(step: StoryboardGenerationStep): boolean {
  return step.kind === "a2v" || step.kind === "create_video";
}

export function isStillGenStep(step: StoryboardGenerationStep): boolean {
  return step.kind === "create_still";
}

export function hasStillSourcePicker(step: StoryboardGenerationStep): boolean {
  return isVideoGenStep(step) || isStillGenStep(step);
}

export function frameStepIdForVideoStep(videoStepId: string): string {
  return stepId("frame", `for-${videoStepId}`);
}

/** Timeline anchor scene for a group-level or scene-level plan step. */
export function anchorSceneForStep(
  step: StoryboardGenerationStep,
  scenes: ProposedScene[],
): ProposedScene | undefined {
  if (step.sceneId) {
    return scenes.find((s) => s.id === step.sceneId);
  }
  if (step.visualGroupId) {
    const inGroup = scenes.filter((s) => s.visualGroupId === step.visualGroupId);
    return [...inGroup].sort((a, b) => a.startSec - b.startSec)[0];
  }
  return undefined;
}

export function findPreviousVideoForStep(
  step: StoryboardGenerationStep,
  scenes: ProposedScene[],
  steps: StoryboardGenerationStep[],
): StoryboardGenerationStep | null {
  const anchor = anchorSceneForStep(step, scenes);
  if (!anchor) return null;
  return findPreviousVideoGenStep(anchor.id, scenes, steps);
}

export function proposalBuildFingerprint(proposal: StoryboardProposal): string {
  const groupPart = proposal.visualGroups
    .map((g) => `${g.id}|${g.productionMethod}|${g.masterSceneId ?? ""}`)
    .join(";");
  const scenePart = proposal.scenes
    .map(
      (s) =>
        `${s.id}|${s.startSec}|${s.endSec}|${s.visualGroupId}|${s.shotType}|${s.productionMethod ?? ""}|${s.reuseFromSceneId ?? ""}`,
    )
    .join(";");
  return `${groupPart}::${scenePart}`;
}

function sceneLabel(scene: ProposedScene): string {
  return scene.title?.trim() || scene.note?.trim() || scene.id;
}

function buildStillPrompt(
  group: VisualGroup,
  scene: ProposedScene,
  styleHints: BuildStyleHints,
): string {
  const hint = [group.basePromptHint, scene.promptHint].filter(Boolean).join(". ");
  return `${styleHints.still}. ${hint}`.trim();
}

function buildAnimatePrompt(
  group: VisualGroup,
  scene: ProposedScene,
  styleHints: BuildStyleHints,
): string {
  const hint = [group.basePromptHint, scene.promptHint].filter(Boolean).join(". ");
  return `${styleHints.animate}. ${hint}`.trim();
}

function representativeScene(
  group: VisualGroup,
  scenes: ProposedScene[],
): ProposedScene | undefined {
  if (group.masterSceneId) {
    return scenes.find((s) => s.id === group.masterSceneId);
  }
  return scenes[0];
}

function videoOutputStepIdForScene(sceneId: string): string {
  return stepId("a2v", `scene-${sceneId}`);
}

function stillOutputStepIdForGroup(groupId: string): string {
  return stepId("still", groupId);
}

function addPlaceStep(
  steps: StoryboardGenerationStep[],
  scene: ProposedScene,
  sourceStepId: string,
  mediaKind: "video" | "image",
): void {
  steps.push({
    id: stepId("place", `scene-${scene.id}`),
    kind: "place_clip",
    label: `Place on timeline — ${sceneLabel(scene)}`,
    sceneId: scene.id,
    status: "pending",
    dependsOn: [sourceStepId],
    sourceStepId,
    prompt: mediaKind,
  });
}

function addNoopStep(
  steps: StoryboardGenerationStep[],
  scene: ProposedScene,
  reason: string,
): void {
  steps.push({
    id: stepId("noop", `scene-${scene.id}`),
    kind: "noop",
    label: `${sceneLabel(scene)} — ${reason}`,
    sceneId: scene.id,
    status: "skipped",
    dependsOn: [],
  });
}

/** Previous timeline scene that has an a2v or i2v step in the plan. */
export function findPreviousVideoGenStep(
  sceneId: string,
  scenes: ProposedScene[],
  steps: StoryboardGenerationStep[],
): StoryboardGenerationStep | null {
  const ordered = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const idx = ordered.findIndex((s) => s.id === sceneId);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const prevSceneId = ordered[i]!.id;
    const videoStep =
      steps.find((s) => s.sceneId === prevSceneId && s.kind === "a2v") ??
      steps.find((s) => s.sceneId === prevSceneId && s.kind === "create_video");
    if (videoStep) return videoStep;
  }
  return null;
}

export type StillSourceOption = {
  value: string;
  label: string;
  group?: "clip" | "plan" | "project";
};

export function encodeStillSource(source: VideoStillSource): string {
  switch (source.mode) {
    case "prompt_only":
      return "none";
    case "previous_video_frame":
      return "prev";
    case "group_still":
      return `group:${source.stillStepId ?? ""}`;
    case "project_image":
      return `img:${source.creationId ?? ""}`;
  }
}

export function decodeStillSource(value: string): VideoStillSource | null {
  if (value === "none") return { mode: "prompt_only" };
  if (value === "prev") return { mode: "previous_video_frame" };
  if (value.startsWith("group:")) {
    const stillStepId = value.slice("group:".length);
    return { mode: "group_still", stillStepId: stillStepId || undefined };
  }
  if (value.startsWith("img:")) {
    const creationId = value.slice("img:".length);
    if (!creationId) return null;
    return { mode: "project_image", creationId };
  }
  return null;
}

export function defaultStillSourceForVideoStep(
  step: StoryboardGenerationStep,
  scenes: ProposedScene[],
  baseSteps: StoryboardGenerationStep[],
): VideoStillSource {
  if (
    step.sceneId &&
    findPreviousVideoGenStep(step.sceneId, scenes, baseSteps)
  ) {
    return { mode: "previous_video_frame" };
  }
  if (step.stillStepId) {
    return { mode: "group_still", stillStepId: step.stillStepId };
  }
  return { mode: "group_still" };
}

export function defaultStillSourceForStillStep(): VideoStillSource {
  return { mode: "prompt_only" };
}

export function effectiveStillSource(
  step: StoryboardGenerationStep,
  scenes: ProposedScene[],
  baseSteps: StoryboardGenerationStep[],
): VideoStillSource {
  if (isStillGenStep(step)) {
    return (
      step.stillSource ?? defaultStillSourceForStillStep()
    );
  }
  return step.stillSource ?? defaultStillSourceForVideoStep(step, scenes, baseSteps);
}

export function stillSourceOptionsForStillStep(
  step: StoryboardGenerationStep,
  baseSteps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
  imageAssets: Array<{ id: string; title: string }>,
): StillSourceOption[] {
  const options: StillSourceOption[] = [
    {
      value: encodeStillSource({ mode: "prompt_only" }),
      label: "Prompt only (no reference)",
      group: "plan",
    },
  ];
  if (findPreviousVideoForStep(step, scenes, baseSteps)) {
    options.push({
      value: encodeStillSource({ mode: "previous_video_frame" }),
      label: "Last frame of previous clip",
      group: "clip",
    });
  }
  for (const planStill of baseSteps.filter((s) => s.kind === "create_still")) {
    if (planStill.id === step.id) continue;
    options.push({
      value: encodeStillSource({
        mode: "group_still",
        stillStepId: planStill.id,
      }),
      label: planStill.label,
      group: "plan",
    });
  }
  for (const img of imageAssets) {
    options.push({
      value: encodeStillSource({
        mode: "project_image",
        creationId: img.id,
      }),
      label: img.title || img.id,
      group: "project",
    });
  }
  return options;
}

export function stillSourceOptionsForStep(
  step: StoryboardGenerationStep,
  baseSteps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
  imageAssets: Array<{ id: string; title: string }>,
): StillSourceOption[] {
  if (isStillGenStep(step)) {
    return stillSourceOptionsForStillStep(step, baseSteps, scenes, imageAssets);
  }
  if (isVideoGenStep(step)) {
    return stillSourceOptionsForVideoStep(step, baseSteps, scenes, imageAssets);
  }
  return [];
}

export function stillSourceOptionsForVideoStep(
  step: StoryboardGenerationStep,
  baseSteps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
  imageAssets: Array<{ id: string; title: string }>,
): StillSourceOption[] {
  const options: StillSourceOption[] = [];
  if (
    step.sceneId &&
    findPreviousVideoGenStep(step.sceneId, scenes, baseSteps)
  ) {
    options.push({
      value: encodeStillSource({ mode: "previous_video_frame" }),
      label: "Last frame of previous clip",
      group: "clip",
    });
  }
  const groupStillId = baseSteps.find((s) => s.id === step.id)?.stillStepId;
  if (groupStillId) {
    const stillStep = baseSteps.find((s) => s.id === groupStillId);
    options.push({
      value: encodeStillSource({
        mode: "group_still",
        stillStepId: groupStillId,
      }),
      label: stillStep?.label ?? "Group still",
      group: "plan",
    });
  }
  for (const planStill of baseSteps.filter((s) => s.kind === "create_still")) {
    if (planStill.id === groupStillId) continue;
    options.push({
      value: encodeStillSource({
        mode: "group_still",
        stillStepId: planStill.id,
      }),
      label: planStill.label,
      group: "plan",
    });
  }
  for (const img of imageAssets) {
    options.push({
      value: encodeStillSource({
        mode: "project_image",
        creationId: img.id,
      }),
      label: img.title || img.id,
      group: "project",
    });
  }
  return options;
}

function migrateLegacyStillSource(
  step: StoryboardGenerationStep,
  prevSteps: StoryboardGenerationStep[],
  saved?: StoryboardGenerationStep,
): VideoStillSource | undefined {
  const legacy = (
    saved as (StoryboardGenerationStep & { chainFromPreviousFrame?: boolean }) | undefined
  )?.chainFromPreviousFrame;
  if (legacy === true) return { mode: "previous_video_frame" };
  if (saved?.stillSource) return saved.stillSource;
  if (step.stillSource) return step.stillSource;
  const frameId = frameStepIdForVideoStep(step.id);
  if (prevSteps.some((s) => s.id === frameId && s.kind === "pull_frame")) {
    return { mode: "previous_video_frame" };
  }
  return undefined;
}

function groupStillStepId(
  step: StoryboardGenerationStep,
  baseSteps: StoryboardGenerationStep[],
): string | undefined {
  return baseSteps.find((s) => s.id === step.id)?.stillStepId;
}

function mergeSavedOntoBase(
  base: StoryboardGenerationStep[],
  prevSteps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
): StoryboardGenerationStep[] {
  const prevById = indexPrevSteps(prevSteps);
  return base.map((step) => {
    const saved = prevById.get(step.id);
    let stillSource =
      saved?.stillSource ?? migrateLegacyStillSource(step, prevSteps, saved);
    if (!stillSource && isVideoGenStep(step)) {
      stillSource = defaultStillSourceForVideoStep(step, scenes, base);
    }
    if (!stillSource && isStillGenStep(step)) {
      stillSource = defaultStillSourceForStillStep();
    }
    if (!saved) {
      return stillSource ? { ...step, stillSource } : step;
    }
    return {
      ...step,
      status: saved.status,
      creationId: saved.creationId,
      error: saved.error,
      completedAt: saved.completedAt,
      stillSource,
    };
  });
}

/** Expand still/video steps into pull_frame sub-steps when needed. */
export function materializeStillSources(
  baseSteps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
  prevSteps: StoryboardGenerationStep[] = [],
): StoryboardGenerationStep[] {
  const prevById = indexPrevSteps(prevSteps);
  const out: StoryboardGenerationStep[] = [];

  for (const step of baseSteps) {
    const isVideo = isVideoGenStep(step) && Boolean(step.sceneId);
    const isStill = isStillGenStep(step);
    if (!isVideo && !isStill) {
      out.push(step);
      continue;
    }

    const source = effectiveStillSource(step, scenes, baseSteps);
    const anchor = anchorSceneForStep(step, scenes);

    if (source.mode === "prompt_only") {
      out.push({
        ...step,
        stillSource: source,
        stillStepId: undefined,
        dependsOn: isStill ? [] : step.dependsOn,
      });
      continue;
    }

    if (source.mode === "previous_video_frame") {
      const prevVideo =
        step.sceneId && isVideo
          ? findPreviousVideoGenStep(step.sceneId, scenes, baseSteps)
          : findPreviousVideoForStep(step, scenes, baseSteps);
      if (prevVideo) {
        const frameId = frameStepIdForVideoStep(step.id);
        const savedFrame = prevById.get(frameId);
        out.push({
          id: frameId,
          kind: "pull_frame",
          label: `Last frame — ${step.label}`,
          sceneId: anchor?.id ?? step.sceneId,
          visualGroupId: step.visualGroupId,
          status: savedFrame?.status ?? "pending",
          creationId: savedFrame?.creationId,
          error: savedFrame?.error,
          completedAt: savedFrame?.completedAt,
          dependsOn: [prevVideo.id],
          sourceStepId: prevVideo.id,
        });
        out.push({
          ...step,
          stillSource: source,
          stillStepId: frameId,
          dependsOn: [frameId],
        });
        continue;
      }
    }

    if (
      source.mode === "group_still" ||
      source.mode === "previous_video_frame"
    ) {
      const stillId =
        source.stillStepId ?? groupStillStepId(step, baseSteps);
      out.push({
        ...step,
        stillSource: source,
        stillStepId: stillId,
        dependsOn: stillId ? [stillId] : isStill ? [] : step.dependsOn,
      });
      continue;
    }

    if (source.mode === "project_image") {
      out.push({
        ...step,
        stillSource: source,
        stillStepId: undefined,
        dependsOn: [],
      });
      continue;
    }

    out.push(step);
  }

  return out;
}

function resolveGroupSteps(
  group: VisualGroup,
  scenesInGroup: ProposedScene[],
  styleHints: BuildStyleHints,
): StoryboardGenerationStep[] {
  const steps: StoryboardGenerationStep[] = [];
  const method: SceneProductionMethod = group.productionMethod;
  const rep = representativeScene(group, scenesInGroup);
  const orderedScenes = [...scenesInGroup].sort((a, b) => a.startSec - b.startSec);

  if (method === "a2v_from_still") {
    const stillId = stillOutputStepIdForGroup(group.id);
    const stillScene = rep ?? orderedScenes[0];
    if (stillScene) {
      steps.push({
        id: stillId,
        kind: "create_still",
        label: `Still — ${group.label}`,
        visualGroupId: group.id,
        status: "pending",
        dependsOn: [],
        prompt: buildStillPrompt(group, stillScene, styleHints),
      });
    }
    for (const scene of orderedScenes) {
      const a2vId = videoOutputStepIdForScene(scene.id);
      steps.push({
        id: a2vId,
        kind: "a2v",
        label: `Lip-sync — ${sceneLabel(scene)}`,
        sceneId: scene.id,
        visualGroupId: group.id,
        status: "pending",
        dependsOn: stillScene ? [stillId] : [],
        stillStepId: stillScene ? stillId : undefined,
        prompt: LAB_A2V_PROMPT,
        vocalSlice: scene.vocalSlice ?? {
          inSec: scene.startSec,
          outSec: scene.endSec,
        },
      });
      addPlaceStep(steps, scene, a2vId, "video");
    }
    return steps;
  }

  if (method === "new_still") {
    const stillId = stillOutputStepIdForGroup(group.id);
    const stillScene = rep ?? scenesInGroup[0];
    if (stillScene) {
      steps.push({
        id: stillId,
        kind: "create_still",
        label: `Still — ${group.label}`,
        visualGroupId: group.id,
        status: "pending",
        dependsOn: [],
        prompt: buildStillPrompt(group, stillScene, styleHints),
      });
    }
    for (const scene of scenesInGroup) {
      addPlaceStep(steps, scene, stillId, "image");
    }
    return steps;
  }

  if (method === "new_video") {
    const stillId = stillOutputStepIdForGroup(group.id);
    const stillScene = rep ?? orderedScenes[0];
    if (stillScene) {
      steps.push({
        id: stillId,
        kind: "create_still",
        label: `Still — ${group.label}`,
        visualGroupId: group.id,
        status: "pending",
        dependsOn: [],
        prompt: buildStillPrompt(group, stillScene, styleHints),
      });
    }
    for (const scene of orderedScenes) {
      const videoId = stepId("video", `scene-${scene.id}`);
      steps.push({
        id: videoId,
        kind: "create_video",
        label: `Video — ${sceneLabel(scene)}`,
        sceneId: scene.id,
        visualGroupId: group.id,
        status: "pending",
        dependsOn: stillScene ? [stillId] : [],
        stillStepId: stillScene ? stillId : undefined,
        prompt: buildAnimatePrompt(group, scene, styleHints),
      });
      addPlaceStep(steps, scene, videoId, "video");
    }
    return steps;
  }

  if (method === "lyric_card") {
    for (const scene of scenesInGroup) {
      addNoopStep(steps, scene, "lyric card (no generation)");
    }
    return steps;
  }

  if (method === "reuse_clip") {
    for (const scene of scenesInGroup) {
      const sourceId = scene.reuseFromSceneId;
      const sourceStepId = sourceId
        ? stepId("place", `scene-${sourceId}`)
        : undefined;
      steps.push({
        id: stepId("place", `scene-${scene.id}`),
        kind: "place_clip",
        label: `Place reused clip — ${sceneLabel(scene)}`,
        sceneId: scene.id,
        status: "pending",
        dependsOn: sourceStepId ? [sourceStepId] : [],
        sourceStepId,
        prompt: "video",
      });
    }
    return steps;
  }

  for (const scene of scenesInGroup) {
    addNoopStep(
      steps,
      scene,
      `${method.replace(/_/g, " ")} — mark done or run manually`,
    );
  }
  return steps;
}

/** Prefer the most advanced saved status when duplicate step ids exist. */
function indexPrevSteps(
  prevSteps: StoryboardGenerationStep[],
): Map<string, StoryboardGenerationStep> {
  const byId = new Map<string, StoryboardGenerationStep>();
  const rank = (status: StoryboardGenerationStep["status"]): number => {
    switch (status) {
      case "done":
      case "skipped":
        return 3;
      case "failed":
        return 2;
      case "running":
        return 1;
      default:
        return 0;
    }
  };
  for (const step of prevSteps) {
    const existing = byId.get(step.id);
    if (!existing || rank(step.status) > rank(existing.status)) {
      byId.set(step.id, step);
    }
  }
  return byId;
}

const STEP_TIMELINE_ORDER: Record<StoryboardGenerationStep["kind"], number> = {
  create_still: 0,
  pull_frame: 1,
  create_video: 2,
  a2v: 2,
  place_clip: 3,
  noop: 4,
};

/** Sort materialized steps in timeline order (group still → scene steps by startSec). */
export function sortPlanStepsByTimeline(
  steps: StoryboardGenerationStep[],
  scenes: ProposedScene[],
): StoryboardGenerationStep[] {
  const sceneOrder = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const sceneIndex = new Map(sceneOrder.map((scene, index) => [scene.id, index]));
  const groupFirstSceneIndex = new Map<string, number>();
  for (const scene of sceneOrder) {
    if (!groupFirstSceneIndex.has(scene.visualGroupId)) {
      groupFirstSceneIndex.set(scene.visualGroupId, sceneIndex.get(scene.id)!);
    }
  }

  const sortKey = (step: StoryboardGenerationStep): number => {
    if (step.kind === "create_still" && step.visualGroupId) {
      const groupIndex = groupFirstSceneIndex.get(step.visualGroupId) ?? 9999;
      return groupIndex * 1000 - 1;
    }
    if (step.sceneId) {
      const sceneIdx = sceneIndex.get(step.sceneId) ?? 9999;
      return sceneIdx * 1000 + STEP_TIMELINE_ORDER[step.kind];
    }
    return 999999;
  };

  return [...steps].sort((a, b) => sortKey(a) - sortKey(b));
}

/** Resolve the base generation plan (before per-step chain expansion). */
export function resolveStoryboardBuildPlan(
  proposal: StoryboardProposal,
  styleHints?: BuildStyleHints,
): StoryboardGenerationStep[] {
  const hints: BuildStyleHints = styleHints ?? {
    still: resolveLabStillPrompt(null),
    animate: resolveLabAnimatePrompt(null),
  };
  const scenesByGroup = new Map<string, ProposedScene[]>();
  for (const scene of proposal.scenes) {
    const list = scenesByGroup.get(scene.visualGroupId) ?? [];
    list.push(scene);
    scenesByGroup.set(scene.visualGroupId, list);
  }

  const steps: StoryboardGenerationStep[] = [];
  const groupsInTimelineOrder = proposal.visualGroups
    .map((group) => {
      const scenesInGroup = (scenesByGroup.get(group.id) ?? []).sort(
        (a, b) => a.startSec - b.startSec,
      );
      const firstStart = scenesInGroup[0]?.startSec ?? Number.POSITIVE_INFINITY;
      return { group, scenesInGroup, firstStart };
    })
    .sort((a, b) => a.firstStart - b.firstStart);

  for (const { group, scenesInGroup } of groupsInTimelineOrder) {
    steps.push(...resolveGroupSteps(group, scenesInGroup, hints));
  }

  return steps;
}

/** Merge freshly resolved steps with persisted user progress. */
export function reconcileGenerationPlan(
  proposal: StoryboardProposal,
  styleHints?: BuildStyleHints,
): StoryboardGenerationPlan {
  const fingerprint = proposalBuildFingerprint(proposal);
  const base = resolveStoryboardBuildPlan(proposal, styleHints);
  const prevSteps = proposal.generationPlan?.steps ?? [];
  const mergedBase = mergeSavedOntoBase(base, prevSteps, proposal.scenes);
  const steps = sortPlanStepsByTimeline(
    materializeStillSources(mergedBase, proposal.scenes, prevSteps),
    proposal.scenes,
  );

  return {
    builtAt: new Date().toISOString(),
    proposalFingerprint: fingerprint,
    steps,
  };
}

/** Set the reference still/frame source for one still, a2v, or i2v step. */
export function setStepStillSource(
  proposal: StoryboardProposal,
  stepId: string,
  stillSource: VideoStillSource,
  styleHints?: BuildStyleHints,
): StoryboardGenerationPlan {
  const prevSteps = proposal.generationPlan?.steps ?? [];
  const base = mergeSavedOntoBase(
    resolveStoryboardBuildPlan(proposal, styleHints),
    prevSteps,
    proposal.scenes,
  ).map((step) => (step.id === stepId ? { ...step, stillSource } : step));

  const steps = sortPlanStepsByTimeline(
    materializeStillSources(base, proposal.scenes, prevSteps),
    proposal.scenes,
  );
  return {
    builtAt: new Date().toISOString(),
    proposalFingerprint: proposalBuildFingerprint(proposal),
    steps,
  };
}

/** @deprecated Use setStepStillSource */
export function setVideoStepStillSource(
  proposal: StoryboardProposal,
  videoStepId: string,
  stillSource: VideoStillSource,
  styleHints?: BuildStyleHints,
): StoryboardGenerationPlan {
  return setStepStillSource(proposal, videoStepId, stillSource, styleHints);
}

export function countPlanProgress(plan: StoryboardGenerationPlan): {
  done: number;
  total: number;
  pending: number;
  runnable: number;
} {
  const actionable = plan.steps.filter((s) => s.kind !== "noop");
  const done = actionable.filter(
    (s) => s.status === "done" || s.status === "skipped",
  ).length;
  const pending = actionable.filter((s) => s.status === "pending").length;
  const runnable = actionable.filter(
    (s) => s.status === "pending" && stepDependenciesMet(s, plan.steps),
  ).length;
  return { done, total: actionable.length, pending, runnable };
}

export function stepDependenciesMet(
  step: StoryboardGenerationStep,
  steps: StoryboardGenerationStep[],
): boolean {
  if (!step.dependsOn.length) return true;
  const byId = new Map(steps.map((s) => [s.id, s]));
  return step.dependsOn.every((id) => {
    const dep = byId.get(id);
    return dep?.status === "done" || dep?.status === "skipped";
  });
}

export function nextRunnableStep(
  plan: StoryboardGenerationPlan,
): StoryboardGenerationStep | null {
  return (
    plan.steps.find(
      (s) =>
        s.kind !== "noop" &&
        s.status === "pending" &&
        stepDependenciesMet(s, plan.steps),
    ) ?? null
  );
}

export function updatePlanStep(
  plan: StoryboardGenerationPlan,
  stepId: string,
  patch: Partial<StoryboardGenerationStep>,
): StoryboardGenerationPlan {
  return {
    ...plan,
    steps: plan.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
  };
}

export function markStepDone(
  plan: StoryboardGenerationPlan,
  stepId: string,
  creationId: string,
): StoryboardGenerationPlan {
  return updatePlanStep(plan, stepId, {
    status: "done",
    creationId,
    error: undefined,
    completedAt: new Date().toISOString(),
  });
}

export function resetStep(
  plan: StoryboardGenerationPlan,
  stepId: string,
): StoryboardGenerationPlan {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step || step.kind === "noop") return plan;
  return updatePlanStep(plan, stepId, {
    status: "pending",
    creationId: undefined,
    error: undefined,
    completedAt: undefined,
  });
}

/** Steps that produce a creation id usable by downstream steps. */
export function creationOutputStepIds(steps: StoryboardGenerationStep[]): Set<string> {
  return new Set(
    steps
      .filter(
        (s) =>
          s.kind === "create_still" ||
          s.kind === "create_video" ||
          s.kind === "a2v" ||
          s.kind === "pull_frame",
      )
      .map((s) => s.id),
  );
}
