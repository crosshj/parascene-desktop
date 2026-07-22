import { useCallback, useMemo, useState } from "react";
import type { Creation } from "../library/types";
import type {
  ProjectAspectRatio,
  StoryboardGenerationPlan,
  StoryboardGenerationStep,
  StoryboardProposal,
  TimelineClip,
} from "../project/types";
import { resolveLabAnimatePrompt, resolveLabStillPrompt } from "./labPrompts";
import {
  decodeStillSource,
  effectiveStillSource,
  encodeStillSource,
  countPlanProgress,
  hasStillSourcePicker,
  markStepDone,
  nextRunnableStep,
  reconcileGenerationPlan,
  resetStep,
  resolveStoryboardBuildPlan,
  setStepStillSource,
  stepDependenciesMet,
  stillSourceOptionsForStep,
  updatePlanStep,
} from "./storyboardBuildPlan";
import type { VideoStillSource } from "../project/types";
import {
  completePlaceStep,
  executeBuildStep,
  placeSceneOnTimeline,
  type BuildRunContext,
} from "./storyboardBuildRun";
import type { MvModuleChrome } from "./LabMvModules";

export type BuildRunner = (
  fn: (ctx: {
    onProgress: (note: string) => void;
    onPendingCreation: (
      id: string | null,
      mediaType?: "image" | "video" | null,
    ) => void;
  }) => Promise<{
    summary: string;
    detail?: string;
    json?: unknown;
    creationId?: string;
  }>,
) => void;

function actionLabel(
  busy: boolean,
  buttonLabel: string | null | undefined,
  idle: string,
  laneActive = false,
): string {
  if (!busy || !laneActive) return idle;
  return buttonLabel?.trim() || "Working…";
}

function ProgressLog({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  return (
    <ol className="lab-progress-log" aria-label="Progress">
      {lines.map((line, i) => (
        <li key={`${i}-${line.slice(0, 24)}`}>{line}</li>
      ))}
    </ol>
  );
}

function stepKindLabel(kind: StoryboardGenerationStep["kind"]): string {
  switch (kind) {
    case "create_still":
      return "Image";
    case "create_video":
      return "i2v";
    case "a2v":
      return "a2v";
    case "pull_frame":
      return "Frame";
    case "place_clip":
      return "Place";
    case "noop":
      return "—";
    default:
      return kind;
  }
}

function statusClass(status: StoryboardGenerationStep["status"]): string {
  return `lab-mv-build-status lab-mv-build-status-${status}`;
}

function pickableAssets(
  step: StoryboardGenerationStep,
  imageAssets: Creation[],
  videoAssets: Creation[],
): Creation[] {
  if (step.kind === "create_still" || step.kind === "pull_frame") return imageAssets;
  if (step.kind === "create_video" || step.kind === "a2v") return videoAssets;
  if (step.kind === "place_clip") {
    return step.prompt === "image" ? imageAssets : videoAssets;
  }
  return [...imageAssets, ...videoAssets];
}

export function MvBuildModule(
  props: {
    projectId: string;
    projectTitle: string;
    aspectRatio: ProjectAspectRatio;
    storyboardProposal: StoryboardProposal | null;
    labStillPrompt: string | null;
    labAnimatePrompt: string | null;
    mixPath: string | null;
    imagesGroupId: string | null;
    videosGroupId: string | null;
    imageAssets: Creation[];
    videoAssets: Creation[];
    timeline: TimelineClip[];
    onPatchGenerationPlan: (
      mutate: (
        plan: StoryboardGenerationPlan | undefined,
        proposal: StoryboardProposal,
      ) => StoryboardGenerationPlan,
    ) => void;
    onCreated: (ids: string[]) => void;
    onTimelineChange: (timeline: TimelineClip[]) => void;
    onRun: BuildRunner;
  } & MvModuleChrome,
) {
  const { onPatchGenerationPlan } = props;
  const proposal = props.storyboardProposal;
  const [activeLane, setActiveLane] = useState<"run" | "runAll" | null>(null);
  const [markingStepId, setMarkingStepId] = useState<string | null>(null);

  const styleHints = useMemo(
    () => ({
      still: resolveLabStillPrompt(props.labStillPrompt),
      animate: resolveLabAnimatePrompt(props.labAnimatePrompt),
    }),
    [props.labStillPrompt, props.labAnimatePrompt],
  );

  const plan = useMemo(() => {
    if (!proposal?.scenes.length) return null;
    return reconcileGenerationPlan(proposal, styleHints);
  }, [proposal, styleHints]);

  const baseSteps = useMemo(() => {
    if (!proposal?.scenes.length) return [];
    return resolveStoryboardBuildPlan(proposal, styleHints);
  }, [proposal, styleHints]);

  const applyPlanPatch = useCallback(
    (
      patch: (plan: StoryboardGenerationPlan) => StoryboardGenerationPlan,
    ): StoryboardGenerationPlan => {
      let next!: StoryboardGenerationPlan;
      onPatchGenerationPlan((current, p) => {
        const reconciled = reconcileGenerationPlan(
          { ...p, generationPlan: current },
          styleHints,
        );
        next = patch(reconciled);
        return next;
      });
      return next;
    },
    [onPatchGenerationPlan, styleHints],
  );

  const progress = plan ? countPlanProgress(plan) : null;

  const runStep = useCallback(
    async (
      step: StoryboardGenerationStep,
      ctx: {
        onProgress: (note: string) => void;
        onPendingCreation: BuildRunContext["onPendingCreation"];
      },
    ): Promise<StoryboardGenerationPlan> => {
      if (!proposal) throw new Error("No storyboard proposal");

      let workingPlan = applyPlanPatch((plan) =>
        updatePlanStep(plan, step.id, {
          status: "running",
          error: undefined,
        }),
      );

      try {
        if (step.kind === "place_clip") {
          ctx.onProgress("Placing clip on timeline…");
          const placed = await completePlaceStep(
            step,
            workingPlan.steps,
            proposal.scenes,
            props.timeline,
          );
          props.onTimelineChange(placed.timeline);
          workingPlan = applyPlanPatch((plan) =>
            markStepDone(plan, step.id, placed.creationId),
          );
          return workingPlan;
        }

        if (step.kind === "noop") {
          workingPlan = applyPlanPatch((plan) =>
            updatePlanStep(plan, step.id, {
              status: "skipped",
              completedAt: new Date().toISOString(),
            }),
          );
          return workingPlan;
        }

        const runCtx: BuildRunContext = {
          projectId: props.projectId,
          projectTitle: props.projectTitle,
          aspectRatio: props.aspectRatio,
          imagesGroupId: props.imagesGroupId,
          videosGroupId: props.videosGroupId,
          mixPath: props.mixPath,
          steps: workingPlan.steps,
          scenes: proposal.scenes,
          onProgress: ctx.onProgress,
          onPendingCreation: ctx.onPendingCreation,
        };
        const result = await executeBuildStep(step, runCtx);
        workingPlan = applyPlanPatch((plan) =>
          markStepDone(plan, step.id, result.creationId),
        );
        if (result.projectCreationIds.length) {
          props.onCreated(result.projectCreationIds);
        }
        return workingPlan;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        workingPlan = applyPlanPatch((plan) =>
          updatePlanStep(plan, step.id, {
            status: "failed",
            error: message,
          }),
        );
        throw err;
      }
    },
    [applyPlanPatch, proposal, props],
  );

  const handleRunNext = () => {
    if (!plan) return;
    const step = nextRunnableStep(plan);
    if (!step) return;
    setActiveLane("run");
    props.onRun(async (ctx) => {
      await runStep(step, ctx);
      return { summary: `Completed: ${step.label}` };
    });
  };

  const handleRunAll = () => {
    if (!plan) return;
    setActiveLane("runAll");
    props.onRun(async (ctx) => {
      let workingPlan = plan;
      let completed = 0;
      while (true) {
        const step = nextRunnableStep(workingPlan);
        if (!step) break;
        workingPlan = await runStep(step, ctx);
        completed++;
      }
      return {
        summary:
          completed > 0
            ? `Completed ${completed} step(s)`
            : "Nothing left to run",
      };
    });
  };

  const handleMarkDone = (stepId: string, creationId: string) => {
    if (!plan || !proposal) return;
    const step = plan.steps.find((s) => s.id === stepId);
    if (step?.kind === "place_clip" && step.sceneId) {
      const scene = proposal.scenes.find((s) => s.id === step.sceneId);
      if (scene) {
        const mediaType = step.prompt === "image" ? "image" : "video";
        props.onTimelineChange(
          placeSceneOnTimeline(
            props.timeline,
            scene,
            creationId,
            mediaType,
          ),
        );
      }
    }
    applyPlanPatch((current) => markStepDone(current, stepId, creationId));
    setMarkingStepId(null);
  };

  const handleRefreshPlan = () => {
    if (!proposal) return;
    applyPlanPatch((current) =>
      reconcileGenerationPlan(
        { ...proposal, generationPlan: current },
        styleHints,
      ),
    );
  };

  const handleStillSource = (
    stepId: string,
    stillSource: VideoStillSource,
  ) => {
    if (!proposal) return;
    applyPlanPatch((current) =>
      setStepStillSource(
        { ...proposal, generationPlan: current },
        stepId,
        stillSource,
        styleHints,
      ),
    );
  };

  const handleReset = (stepId: string) => {
    if (!plan) return;
    applyPlanPatch((current) => resetStep(current, stepId));
  };

  if (!proposal?.scenes.length) {
    return (
      <p className="muted">
        Propose scenes in MV Scenes first, then return here to build them.
      </p>
    );
  }

  return (
    <div className="lab-form lab-mv-build">
      <p className="muted">
        Review the generation plan for each scene. Mark steps you already finished
        manually, or run the build to create stills, a2v, and i2v clips and
        place them on the editor timeline. For each a2v or i2v step, pick which
        still or frame seeds the generation.
      </p>

      {progress ? (
        <div className="lab-mv-build-summary">
          <p>
            Progress: {progress.done} / {progress.total} · {progress.runnable}{" "}
            ready to run
          </p>
        </div>
      ) : null}

      <div className="lab-mv-build-actions">
        <button
          type="button"
          className={
            props.busy && activeLane === "run"
              ? "primary-btn is-busy"
              : "primary-btn"
          }
          disabled={
            props.busy || !plan || !nextRunnableStep(plan)
          }
          onClick={handleRunNext}
        >
          {actionLabel(
            props.busy,
            props.buttonLabel,
            "Run next step",
            activeLane === "run",
          )}
        </button>
        <button
          type="button"
          className={
            props.busy && activeLane === "runAll"
              ? "primary-btn is-busy"
              : "lab-secondary-btn"
          }
          disabled={props.busy || !plan || progress?.runnable === 0}
          onClick={handleRunAll}
        >
          {actionLabel(
            props.busy,
            props.buttonLabel,
            "Run all pending",
            activeLane === "runAll",
          )}
        </button>
        <button
          type="button"
          className="lab-secondary-btn"
          disabled={props.busy || !proposal}
          onClick={handleRefreshPlan}
        >
          Refresh plan
        </button>
      </div>

      {plan ? (
        <div className="lab-mv-build-table-wrap">
          <table className="lab-mv-build-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Op</th>
              <th>Still / frame</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {plan.steps.map((step) => {
              const blocked =
                step.status === "pending" &&
                !stepDependenciesMet(step, plan.steps);
              const assets = pickableAssets(
                step,
                props.imageAssets,
                props.videoAssets,
              );
              const isMarking = markingStepId === step.id;
              return (
                <tr
                  key={step.id}
                  className={
                    blocked
                      ? "is-blocked"
                      : step.status === "done"
                        ? "is-done"
                        : undefined
                  }
                >
                  <td>
                    <div className="lab-mv-build-step-label">{step.label}</div>
                    {step.vocalSlice ? (
                      <div className="lab-mv-build-step-meta muted">
                        Vocals {step.vocalSlice.inSec.toFixed(1)}–
                        {step.vocalSlice.outSec.toFixed(1)}s
                      </div>
                    ) : null}
                    {step.creationId ? (
                      <div className="lab-mv-build-step-meta muted">
                        Asset {step.creationId}
                      </div>
                    ) : null}
                    {step.error ? (
                      <div className="lab-mv-build-step-error">{step.error}</div>
                    ) : null}
                  </td>
                  <td>{stepKindLabel(step.kind)}</td>
                  <td className="lab-mv-build-still-cell">
                    {hasStillSourcePicker(step) && proposal ? (
                      <select
                        className="lab-mv-build-still-pick"
                        value={encodeStillSource(
                          effectiveStillSource(
                            baseSteps.find((b) => b.id === step.id) ?? step,
                            proposal.scenes,
                            baseSteps,
                          ),
                        )}
                        disabled={props.busy}
                        onChange={(e) => {
                          const src = decodeStillSource(e.target.value);
                          if (src) handleStillSource(step.id, src);
                        }}
                      >
                        {stillSourceOptionsForStep(
                          baseSteps.find((b) => b.id === step.id) ?? step,
                          baseSteps,
                          proposal.scenes,
                          props.imageAssets.map((a) => ({
                            id: a.id,
                            title: a.title,
                          })),
                        ).map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    ) : step.kind === "pull_frame" ? (
                      <span className="muted" title="Pulled from previous clip">
                        ↳ prev clip
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={statusClass(step.status)}>
                      {step.status}
                    </span>
                  </td>
                  <td className="lab-mv-build-step-actions">
                    {step.kind !== "noop" &&
                    step.status !== "done" &&
                    step.status !== "skipped" ? (
                      <>
                        {isMarking ? (
                          <select
                            className="lab-mv-build-asset-pick"
                            defaultValue=""
                            onChange={(e) => {
                              const id = e.target.value;
                              if (id) handleMarkDone(step.id, id);
                            }}
                          >
                            <option value="">Pick existing asset…</option>
                            {assets.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.title || a.id}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <button
                            type="button"
                            className="lab-secondary-btn lab-mv-build-btn-sm"
                            disabled={props.busy || blocked}
                            onClick={() => setMarkingStepId(step.id)}
                          >
                            Mark done
                          </button>
                        )}
                      </>
                    ) : null}
                    {step.status === "done" || step.status === "failed" ? (
                      <button
                        type="button"
                        className="lab-secondary-btn lab-mv-build-btn-sm"
                        disabled={props.busy}
                        onClick={() => handleReset(step.id)}
                      >
                        Reset
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      ) : null}

      <ProgressLog lines={props.progressLog} />
    </div>
  );
}
