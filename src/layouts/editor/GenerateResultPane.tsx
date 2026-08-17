import type { AddAssetGeneration } from "../../project/types";
import {
  addAssetGenerationProgress,
  type AddAssetGenerationSession,
} from "./addAssetGenerate";
import type { GenerateDualPhase } from "./generateDualView";

type GenerateResultPaneProps = {
  phase: GenerateDualPhase;
  session?: AddAssetGenerationSession | null;
  generation?: AddAssetGeneration | null;
  /** When done and media is shown by the parent, keep this pane minimal. */
  mediaHostedByParent?: boolean;
  onGenerateNew?: () => void;
  nowMs?: number;
  /** Library / lightweight progress when no timeline session exists. */
  progressNote?: string | null;
  startedAtMs?: number | null;
  expectedMs?: number;
  errorMessage?: string | null;
  doneMessage?: string | null;
};

function providerLabel(generation: AddAssetGeneration): string {
  const server = generation.server?.trim() || generation.provider?.trim();
  if (server === "blue_direct") return "Direct to Blue";
  if (server === "parascene_blue" || server === "parascene") return "Parascene";
  if (server === "replicate") return "Replicate";
  return server || "Generate";
}

/** Result side of dual view — staging, progress, or success note. */
export function GenerateResultPane({
  phase,
  session = null,
  generation = null,
  mediaHostedByParent = false,
  onGenerateNew,
  nowMs,
  progressNote = null,
  startedAtMs = null,
  expectedMs = 60_000,
  errorMessage = null,
  doneMessage = null,
}: GenerateResultPaneProps) {
  const tickMs = nowMs ?? 0;
  if (phase === "running") {
    const started = session?.startedAtMs ?? startedAtMs ?? tickMs;
    const expected = session?.expectedMs ?? expectedMs;
    const note =
      session?.progressNote?.trim() ||
      progressNote?.trim() ||
      "Working…";
    const progress = addAssetGenerationProgress(
      Math.max(0, tickMs - started),
      expected,
    );
    return (
      <div className="generate-result-pane" aria-live="polite">
        <h3 className="generate-result-title">Generating…</h3>
        <div
          className={`add-asset-generate-progress${
            progress.indeterminate ? " is-indeterminate" : ""
          }`}
        >
          <div
            className="add-asset-generate-progress-bar"
            style={{ width: `${Math.round(progress.percent)}%` }}
          />
        </div>
        <p className="muted generate-result-note">{note}</p>
        {session?.steps?.length ? (
          <ul className="generate-result-steps">
            {session.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                {step.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (phase === "error") {
    const message =
      session?.errorMessage?.trim() ||
      errorMessage?.trim() ||
      "Generation failed. Switch to Form to edit and try again.";
    return (
      <div className="generate-result-pane" role="alert">
        <h3 className="generate-result-title">Generation error</h3>
        <p className="add-asset-generate-error">{message}</p>
      </div>
    );
  }

  if (phase === "done") {
    if (mediaHostedByParent) {
      return null;
    }
    if (generation) {
      return (
        <div className="generate-result-pane">
          <h3 className="generate-result-title">Generated</h3>
          <p className="muted generate-result-note">
            {providerLabel(generation)}
            {generation.model?.trim() ? ` · ${generation.model.trim()}` : ""}
          </p>
          {generation.prompt.trim() ? (
            <p className="generate-result-prompt">{generation.prompt.trim()}</p>
          ) : null}
          {onGenerateNew ? (
            <button type="button" className="btn" onClick={onGenerateNew}>
              Generate new
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="generate-result-pane">
        <h3 className="generate-result-title">Generated</h3>
        <p className="muted generate-result-note">
          {doneMessage?.trim() ||
            progressNote?.trim() ||
            "Added to Assets."}
        </p>
        {onGenerateNew ? (
          <button type="button" className="btn" onClick={onGenerateNew}>
            Generate new
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="generate-result-pane">
      <h3 className="generate-result-title">Result</h3>
      <p className="muted generate-result-note">
        Generated media will show here. Stay on Form to set prompt, model, and
        frames, then Generate.
      </p>
    </div>
  );
}
