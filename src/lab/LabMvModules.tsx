import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  LyricAlignment,
  ProjectAspectRatio,
  ProposedScene,
  StoryboardBudget,
  StoryboardConceptOption,
  StoryboardProposal,
} from "../project/types";
import {
  applyLockedConcept,
  appendBrainstormTurn,
  ensureStoryboardProposal,
  generateStoryboardConceptOptions,
  lockStoryboardConcept,
  refineStoryboardConceptOption,
  scoreManualStoryboardConcept,
  type ManualConceptDraft,
} from "./storyboardBrainstorm";
import { planStoryboardBudget } from "./storyboardBudget";
import {
  buildProductionManifest,
  proposeStoryboardScenes,
} from "./storyboardPropose";
import { songDurationFromAlignment } from "./storyboardContext";
import { loadOpenAiApiKey } from "./openaiClient";
import { resolveLabAnimatePrompt, resolveLabStillPrompt } from "./labPrompts";
import { LabStoryboardEditor } from "./LabStoryboardEditor";
import { useLabMainAudioPaths } from "./useLabMainAudioPaths";
import { isInaudibleLyricLine } from "./lyricAlign";

export type MvRunner = (
  fn: (ctx: {
    onProgress: (note: string) => void;
  }) => Promise<{
    summary: string;
    detail?: string;
    json?: unknown;
  }>,
) => void;

export type MvModuleChrome = {
  busy: boolean;
  buttonLabel?: string | null;
  progressLog?: string[];
  onRun: MvRunner;
};

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

function FeasibilityBadge({ score }: { score: number }) {
  const tier = score >= 80 ? "high" : score >= 60 ? "med" : "low";
  return (
    <span className={`lab-mv-feasibility lab-mv-feasibility-${tier}`}>
      {score}
    </span>
  );
}

function LockedConceptCard(props: {
  concept: NonNullable<StoryboardProposal["brainstorm"]["lockedConcept"]>;
  children?: ReactNode;
}) {
  const c = props.concept;
  return (
    <div className="lab-mv-locked-concept">
      <div className="lab-mv-locked-concept-head">
        <h4>{c.title}</h4>
        <FeasibilityBadge score={c.feasibilityScore} />
      </div>
      <p className="muted">{c.logline}</p>
      <p>
        <strong>Visual:</strong> {c.visualApproach}
      </p>
      <p>
        <strong>Mood:</strong> {c.mood}
      </p>
      <p className="lab-mv-feasibility-rationale">{c.feasibilityRationale}</p>
      {c.tradeoffs ? (
        <p className="muted">
          <strong>Tradeoffs:</strong> {c.tradeoffs}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}

function matchingAlignment(
  alignment: LyricAlignment | null,
  mainAudioId: string,
): LyricAlignment | null {
  if (!alignment) return null;
  if (mainAudioId && alignment.sourceAudioCreationId !== mainAudioId) {
    return null;
  }
  return alignment;
}

function latestConceptOptions(
  proposal: StoryboardProposal,
): StoryboardConceptOption[] {
  for (let i = proposal.brainstorm.turns.length - 1; i >= 0; i--) {
    const turn = proposal.brainstorm.turns[i];
    if (turn.options?.length) return turn.options;
    if (turn.refinedOption) return [turn.refinedOption];
  }
  return [];
}

function useDebouncedProposalSave(
  onChange: (proposal: StoryboardProposal) => void,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback(
    (proposal: StoryboardProposal) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => onChange(proposal), 400);
    },
    [onChange],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return save;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function MvConceptModule(
  props: {
    projectTitle: string;
    aspectRatio: ProjectAspectRatio;
    mainAudioId: string;
    lyricAlignment: LyricAlignment | null;
    storyboardProposal: StoryboardProposal | null;
    seedDirection: string | null;
    labStillPrompt: string | null;
    labAnimatePrompt: string | null;
    onStoryboardProposalChange: (proposal: StoryboardProposal) => void;
    onSeedDirectionChange: (direction: string | null) => void;
    onContinue?: () => void;
  } & MvModuleChrome,
) {
  const alignment = matchingAlignment(props.lyricAlignment, props.mainAudioId);
  const durationSec = songDurationFromAlignment(alignment);
  const locked = props.storyboardProposal?.brainstorm.lockedConcept;

  const [tab, setTab] = useState<"explore" | "manual">("explore");
  const [seedPrompt, setSeedPrompt] = useState(props.seedDirection ?? "");
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [refineText, setRefineText] = useState("");
  const [activeLane, setActiveLane] = useState<
    "brainstorm" | "refine" | "score" | null
  >(null);
  const [manual, setManual] = useState<ManualConceptDraft>({
    title: "",
    logline: "",
    visualApproach: "",
    mood: "",
    tradeoffs: "",
  });
  const seedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const proposal = useMemo(() => {
    if (!alignment || !props.mainAudioId) return null;
    return ensureStoryboardProposal(props.storyboardProposal, {
      sourceAudioCreationId: props.mainAudioId,
      durationSec,
      aspectRatio: props.aspectRatio,
      seedPrompt: seedPrompt.trim() || undefined,
    });
  }, [
    alignment,
    props.mainAudioId,
    props.storyboardProposal,
    durationSec,
    props.aspectRatio,
    seedPrompt,
  ]);

  const options = proposal ? latestConceptOptions(proposal) : [];
  const selectedOption =
    options.find((o) => o.id === selectedOptionId) ?? options[0] ?? null;

  useEffect(() => {
    // Sync when the parent project direction changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeedPrompt(props.seedDirection ?? "");
  }, [props.seedDirection]);

  const scheduleSeedSave = (text: string) => {
    if (seedTimer.current) clearTimeout(seedTimer.current);
    seedTimer.current = setTimeout(() => {
      props.onSeedDirectionChange(text.trim() || null);
    }, 400);
  };

  const styleHints = {
    still: resolveLabStillPrompt(props.labStillPrompt),
    animate: resolveLabAnimatePrompt(props.labAnimatePrompt),
  };

  const persistProposal = (next: StoryboardProposal) => {
    props.onStoryboardProposalChange(next);
  };

  const lockOption = (option: StoryboardConceptOption, source: "brainstorm") => {
    if (!proposal) return;
    const concept = lockStoryboardConcept({ source, option });
    persistProposal(applyLockedConcept(proposal, concept));
  };

  if (!alignment) {
    return (
      <p className="muted">Lyric alignment for the main song is required.</p>
    );
  }

  return (
    <div className="lab-form lab-mv-concept">
      <p className="muted">
        Brainstorm music-video concepts from your aligned lyrics, or enter your
        own direction. Lock one concept to continue to MV Budget.
      </p>

      {locked ? (
        <LockedConceptCard concept={locked}>
          {props.onContinue ? (
            <button
              type="button"
              className="lab-secondary-btn"
              onClick={() => props.onContinue?.()}
            >
              Continue to MV Budget
            </button>
          ) : null}
        </LockedConceptCard>
      ) : null}

      {!locked ? (
        <>
          <label>
            Creative seed (optional)
            <textarea
              rows={2}
              value={seedPrompt}
              onChange={(e) => {
                setSeedPrompt(e.target.value);
                scheduleSeedSave(e.target.value);
              }}
              placeholder="e.g. neon noir, single location, heavy lip-sync"
            />
          </label>

          <fieldset className="lab-mv-mode">
            <legend>Concept approach</legend>
            <div className="lab-mv-tabs" role="radiogroup" aria-label="Concept approach">
              <label
                className={tab === "explore" ? "is-active" : ""}
              >
                <input
                  type="radio"
                  name="mv-concept-mode"
                  className="sr-only"
                  checked={tab === "explore"}
                  onChange={() => setTab("explore")}
                />
                Explore with AI
              </label>
              <label
                className={tab === "manual" ? "is-active" : ""}
              >
                <input
                  type="radio"
                  name="mv-concept-mode"
                  className="sr-only"
                  checked={tab === "manual"}
                  onChange={() => setTab("manual")}
                />
                I have my direction
              </label>
            </div>
          </fieldset>

          {tab === "explore" ? (
            <>
              <button
                type="button"
                className={
                  props.busy && activeLane === "brainstorm"
                    ? "primary-btn is-busy"
                    : "primary-btn"
                }
                disabled={props.busy}
                onClick={() => {
                  setActiveLane("brainstorm");
                  props.onRun(async ({ onProgress }) => {
                    const apiKey = loadOpenAiApiKey();
                    if (!apiKey) {
                      throw new Error(
                        "OpenAI API key missing — set it in Settings (account menu).",
                      );
                    }
                    const base = ensureStoryboardProposal(
                      props.storyboardProposal,
                      {
                        sourceAudioCreationId: props.mainAudioId,
                        durationSec,
                        aspectRatio: props.aspectRatio,
                        seedPrompt: seedPrompt.trim() || undefined,
                      },
                    );
                    const result = await generateStoryboardConceptOptions({
                      apiKey,
                      projectTitle: props.projectTitle,
                      aspectRatio: props.aspectRatio,
                      alignment,
                      seedPrompt: seedPrompt.trim() || undefined,
                      styleHints,
                      onProgress,
                    });
                    const next = {
                      ...base,
                      brainstorm: appendBrainstormTurn(base.brainstorm, {
                        kind: "options",
                        options: result.options,
                      }),
                    };
                    persistProposal(next);
                    setSelectedOptionId(result.options[0]?.id ?? null);
                    return {
                      summary: `Generated ${result.options.length} concepts`,
                      json: {
                        request: result.request,
                        response: result.response,
                      },
                    };
                  });
                }}
              >
                {actionLabel(
                  props.busy,
                  props.buttonLabel,
                  "Generate concepts",
                  activeLane === "brainstorm",
                )}
              </button>

              {options.length > 0 ? (
                <div className="lab-mv-concept-cards">
                  {options.map((opt) => (
                    <article
                      key={opt.id}
                      className={[
                        "lab-mv-concept-card",
                        selectedOption?.id === opt.id ? "is-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setSelectedOptionId(opt.id)}
                    >
                      <div className="lab-mv-concept-card-head">
                        <h4>{opt.title}</h4>
                        <FeasibilityBadge score={opt.feasibilityScore} />
                      </div>
                      <p>{opt.logline}</p>
                      <p className="muted">{opt.visualApproach}</p>
                      <button
                        type="button"
                        className="lab-secondary-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (opt.feasibilityScore < 50) {
                            const ok = window.confirm(
                              `Feasibility is ${opt.feasibilityScore}/100. Lock anyway?`,
                            );
                            if (!ok) return;
                          }
                          lockOption(opt, "brainstorm");
                        }}
                      >
                        Lock concept
                      </button>
                    </article>
                  ))}
                </div>
              ) : null}

              {selectedOption ? (
                <div className="lab-mv-refine">
                  <h4>Refine “{selectedOption.title}”</h4>
                  <label>
                    Feedback
                    <textarea
                      rows={2}
                      value={refineText}
                      onChange={(e) => setRefineText(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className={
                      props.busy && activeLane === "refine"
                        ? "lab-secondary-btn is-busy"
                        : "lab-secondary-btn"
                    }
                    disabled={props.busy || !refineText.trim()}
                    onClick={() => {
                      setActiveLane("refine");
                      props.onRun(async ({ onProgress }) => {
                        const apiKey = loadOpenAiApiKey();
                        if (!apiKey) {
                          throw new Error(
                            "OpenAI API key missing — set it in Settings (account menu).",
                          );
                        }
                        const base = ensureStoryboardProposal(
                          props.storyboardProposal,
                          {
                            sourceAudioCreationId: props.mainAudioId,
                            durationSec,
                            aspectRatio: props.aspectRatio,
                            seedPrompt: seedPrompt.trim() || undefined,
                          },
                        );
                        const result = await refineStoryboardConceptOption({
                          apiKey,
                          projectTitle: props.projectTitle,
                          aspectRatio: props.aspectRatio,
                          alignment,
                          seedPrompt: seedPrompt.trim() || undefined,
                          styleHints,
                          selectedOption,
                          userFeedback: refineText,
                          onProgress,
                        });
                        const next = {
                          ...base,
                          brainstorm: appendBrainstormTurn(base.brainstorm, {
                            kind: "refine",
                            refinedOption: result.option,
                            parentOptionId: selectedOption.id,
                            userMessage: refineText.trim(),
                          }),
                        };
                        persistProposal(next);
                        setSelectedOptionId(result.option.id);
                        setRefineText("");
                        return {
                          summary: "Refined concept",
                          json: {
                            request: result.request,
                            response: result.response,
                          },
                        };
                      });
                    }}
                  >
                    {actionLabel(
                      props.busy,
                      props.buttonLabel,
                      "Refine",
                      activeLane === "refine",
                    )}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="lab-mv-manual">
              <label>
                Title
                <input
                  value={manual.title}
                  onChange={(e) =>
                    setManual((m) => ({ ...m, title: e.target.value }))
                  }
                />
              </label>
              <label>
                Logline
                <textarea
                  rows={2}
                  value={manual.logline}
                  onChange={(e) =>
                    setManual((m) => ({ ...m, logline: e.target.value }))
                  }
                />
              </label>
              <label>
                Visual approach
                <textarea
                  rows={2}
                  value={manual.visualApproach}
                  onChange={(e) =>
                    setManual((m) => ({
                      ...m,
                      visualApproach: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Mood
                <input
                  value={manual.mood}
                  onChange={(e) =>
                    setManual((m) => ({ ...m, mood: e.target.value }))
                  }
                />
              </label>
              <label>
                Tradeoffs (optional)
                <textarea
                  rows={2}
                  value={manual.tradeoffs ?? ""}
                  onChange={(e) =>
                    setManual((m) => ({ ...m, tradeoffs: e.target.value }))
                  }
                />
              </label>
              <button
                type="button"
                className={
                  props.busy && activeLane === "score"
                    ? "primary-btn is-busy"
                    : "primary-btn"
                }
                disabled={
                  props.busy ||
                  !manual.title.trim() ||
                  !manual.logline.trim()
                }
                onClick={() => {
                  setActiveLane("score");
                  props.onRun(async ({ onProgress }) => {
                    const apiKey = loadOpenAiApiKey();
                    if (!apiKey) {
                      throw new Error(
                        "OpenAI API key missing — set it in Settings (account menu).",
                      );
                    }
                    const base = ensureStoryboardProposal(
                      props.storyboardProposal,
                      {
                        sourceAudioCreationId: props.mainAudioId,
                        durationSec,
                        aspectRatio: props.aspectRatio,
                        seedPrompt: seedPrompt.trim() || undefined,
                      },
                    );
                    const scored = await scoreManualStoryboardConcept({
                      apiKey,
                      projectTitle: props.projectTitle,
                      aspectRatio: props.aspectRatio,
                      alignment,
                      draft: manual,
                      styleHints,
                      onProgress,
                    });
                    const concept = lockStoryboardConcept({
                      source: "manual",
                      option: {
                        ...manual,
                        feasibilityScore: scored.score.feasibilityScore,
                        feasibilityRationale: scored.score.feasibilityRationale,
                        tradeoffs: scored.score.tradeoffs,
                      },
                    });
                    if (concept.feasibilityScore < 50) {
                      const ok = window.confirm(
                        `Feasibility is ${concept.feasibilityScore}/100. Lock anyway?`,
                      );
                      if (!ok) {
                        return {
                          summary: "Lock cancelled",
                        };
                      }
                    }
                    persistProposal(applyLockedConcept(base, concept));
                    return {
                      summary: `Locked manual concept (${concept.feasibilityScore}/100)`,
                      json: {
                        request: scored.request,
                        response: scored.response,
                      },
                    };
                  });
                }}
              >
                {actionLabel(
                  props.busy,
                  props.buttonLabel,
                  "Score & lock concept",
                  activeLane === "score",
                )}
              </button>
            </div>
          )}
        </>
      ) : null}

      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

export function MvBudgetModule(
  props: {
    projectTitle: string;
    aspectRatio: ProjectAspectRatio;
    mainAudioId: string;
    lyricAlignment: LyricAlignment | null;
    storyboardProposal: StoryboardProposal | null;
    labStillPrompt: string | null;
    labAnimatePrompt: string | null;
    onStoryboardProposalChange: (proposal: StoryboardProposal) => void;
    onContinue?: () => void;
  } & MvModuleChrome,
) {
  const alignment = matchingAlignment(props.lyricAlignment, props.mainAudioId);
  const locked = props.storyboardProposal?.brainstorm.lockedConcept;
  const budget = props.storyboardProposal?.budget;
  const debouncedSave = useDebouncedProposalSave(props.onStoryboardProposalChange);
  const [activeLane, setActiveLane] = useState<"plan" | null>(null);

  const styleHints = {
    still: resolveLabStillPrompt(props.labStillPrompt),
    animate: resolveLabAnimatePrompt(props.labAnimatePrompt),
  };

  const updateBudget = (patch: Partial<StoryboardBudget>) => {
    if (!props.storyboardProposal?.budget) return;
    debouncedSave({
      ...props.storyboardProposal,
      budget: { ...props.storyboardProposal.budget, ...patch },
    });
  };

  if (!alignment || !locked) {
    return <p className="muted">Lock a concept in MV Concept first.</p>;
  }

  return (
    <div className="lab-form lab-mv-budget">
      <LockedConceptCard concept={locked} />

      <button
        type="button"
        className={
          props.busy && activeLane === "plan"
            ? "primary-btn is-busy"
            : "primary-btn"
        }
        disabled={props.busy}
        onClick={() => {
          setActiveLane("plan");
          props.onRun(async ({ onProgress }) => {
            const apiKey = loadOpenAiApiKey();
            if (!apiKey) {
              throw new Error(
                "OpenAI API key missing — set it in Settings (account menu).",
              );
            }
            const base =
              props.storyboardProposal ??
              ensureStoryboardProposal(null, {
                sourceAudioCreationId: props.mainAudioId,
                durationSec: songDurationFromAlignment(alignment),
                aspectRatio: props.aspectRatio,
              });
            const result = await planStoryboardBudget({
              apiKey,
              projectTitle: props.projectTitle,
              aspectRatio: props.aspectRatio,
              alignment,
              lockedConcept: locked,
              styleHints,
              onProgress,
            });
            props.onStoryboardProposalChange({
              ...base,
              budget: result.budget,
            });
            return {
              summary: "Budget planned",
              json: { request: result.request, response: result.response },
            };
          });
        }}
      >
        {actionLabel(
          props.busy,
          props.buttonLabel,
          budget ? "Re-plan budget" : "Plan budget",
          activeLane === "plan",
        )}
      </button>

      {budget ? (
        <div className="lab-mv-budget-fields">
          <label>
            Max unique stills
            <input
              type="number"
              min={1}
              value={budget.maxUniqueStills}
              onChange={(e) =>
                updateBudget({ maxUniqueStills: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Max unique video masters
            <input
              type="number"
              min={1}
              value={budget.maxUniqueVideoMasters}
              onChange={(e) =>
                updateBudget({
                  maxUniqueVideoMasters: Number(e.target.value),
                })
              }
            />
          </label>
          <label>
            Target scene count
            <input
              type="number"
              min={1}
              value={budget.targetSceneCount}
              onChange={(e) =>
                updateBudget({ targetSceneCount: Number(e.target.value) })
              }
            />
          </label>
          <label>
            Reuse strategy
            <textarea
              rows={3}
              value={budget.reuseStrategy}
              onChange={(e) =>
                updateBudget({ reuseStrategy: e.target.value })
              }
            />
          </label>
          {budget.sectionNotes?.length ? (
            <div className="lab-mv-section-notes">
              <h4>Section notes</h4>
              <ul>
                {budget.sectionNotes.map((note, i) => (
                  <li key={`${note.tag}-${i}`}>
                    <strong>{note.tag}</strong>{" "}
                    {note.startSec.toFixed(0)}–{note.endSec.toFixed(0)}s:{" "}
                    {note.note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {props.onContinue ? (
            <button
              type="button"
              className="lab-secondary-btn"
              onClick={() => props.onContinue?.()}
            >
              Continue to MV Scenes
            </button>
          ) : null}
        </div>
      ) : null}

      <ProgressLog lines={props.progressLog} />
    </div>
  );
}

export function MvScenesModule(
  props: {
    projectTitle: string;
    aspectRatio: ProjectAspectRatio;
    mainAudioId: string;
    lyricAlignment: LyricAlignment | null;
    storyboardProposal: StoryboardProposal | null;
    labStillPrompt: string | null;
    labAnimatePrompt: string | null;
    onStoryboardProposalChange: (proposal: StoryboardProposal) => void;
    onContinue?: () => void;
  } & MvModuleChrome,
) {
  const alignment = matchingAlignment(props.lyricAlignment, props.mainAudioId);
  const locked = props.storyboardProposal?.brainstorm.lockedConcept;
  const budget = props.storyboardProposal?.budget;
  const proposal = props.storyboardProposal;
  const audioPaths = useLabMainAudioPaths(props.mainAudioId);
  const debouncedSave = useDebouncedProposalSave(props.onStoryboardProposalChange);
  const [activeLane, setActiveLane] = useState<"propose" | null>(null);

  const styleHints = {
    still: resolveLabStillPrompt(props.labStillPrompt),
    animate: resolveLabAnimatePrompt(props.labAnimatePrompt),
  };

  const sungLines = alignment?.lines.filter((l) => !isInaudibleLyricLine(l));

  if (!alignment || !locked || !budget || !proposal) {
    return <p className="muted">Complete MV Concept and MV Budget first.</p>;
  }

  const checklist = proposal.scenes.length ? (
    <div className="lab-mv-checklist-summary">
      <p>
        Scenes: {proposal.scenes.length} · Unique stills:{" "}
        {proposal.uniqueStillCount ?? "—"} / {budget.maxUniqueStills} · Video
        masters: {proposal.uniqueVideoMasterCount ?? "—"} /{" "}
        {budget.maxUniqueVideoMasters}
      </p>
    </div>
  ) : null;

  return (
    <div className="lab-form lab-mv-scenes">
      <p className="muted">
        Propose timed scenes from your locked concept and budget. Edit timing and
        notes on the timeline below.
      </p>

      <button
        type="button"
        className={
          props.busy && activeLane === "propose"
            ? "primary-btn is-busy"
            : "primary-btn"
        }
        disabled={props.busy}
        onClick={() => {
          setActiveLane("propose");
          props.onRun(async ({ onProgress }) => {
            const apiKey = loadOpenAiApiKey();
            if (!apiKey) {
              throw new Error(
                "OpenAI API key missing — set it in Settings (account menu).",
              );
            }
            const result = await proposeStoryboardScenes({
              apiKey,
              projectTitle: props.projectTitle,
              aspectRatio: props.aspectRatio,
              alignment,
              lockedConcept: locked,
              budget,
              durationSec: proposal.durationSec,
              styleHints,
              onProgress,
            });
            props.onStoryboardProposalChange({
              ...proposal,
              ...result.partial,
            });
            return {
              summary: `Proposed ${result.partial.scenes.length} scenes`,
              json: { request: result.request, response: result.response },
            };
          });
        }}
      >
        {actionLabel(
          props.busy,
          props.buttonLabel,
          proposal.scenes.length ? "Re-propose scenes" : "Propose scenes",
          activeLane === "propose",
        )}
      </button>

      {checklist}

      {proposal.scenes.length > 0 ? (
        <>
          <LabStoryboardEditor
            proposal={proposal}
            mixPath={audioPaths.mixPath}
            mixUrl={audioPaths.mixUrl}
            vocalsMediaUrl={audioPaths.vocalsUrl}
            lyricLines={sungLines}
            onChange={(scenes: ProposedScene[]) => {
              debouncedSave({ ...proposal, scenes });
            }}
          />
          <div className="lab-mv-export">
            <button
              type="button"
              className="lab-secondary-btn"
              onClick={() =>
                downloadJson(
                  `${props.projectTitle || "storyboard"}-proposal.json`,
                  proposal,
                )
              }
            >
              Export proposal JSON
            </button>
            <button
              type="button"
              className="lab-secondary-btn"
              onClick={() =>
                downloadJson(
                  `${props.projectTitle || "storyboard"}-manifest.json`,
                  buildProductionManifest(proposal),
                )
              }
            >
              Export production manifest
            </button>
            {props.onContinue ? (
              <button
                type="button"
                className="lab-secondary-btn"
                onClick={() => props.onContinue?.()}
              >
                Continue to MV Build
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      <ProgressLog lines={props.progressLog} />
    </div>
  );
}
