import { useEffect, useState } from "react";
import type { AddAssetGeneration } from "../../project/types";
import {
  addAssetGenerationProgress,
  type AddAssetGenerationSession,
} from "./addAssetGenerate";
import type { GenerateDualPhase } from "./generateDualView";
import { GenerationErrorStatus } from "./GenerationErrorAlert";

type GenerateResultPaneProps = {
  phase: GenerateDualPhase;
  session?: AddAssetGenerationSession | null;
  generation?: AddAssetGeneration | null;
  /** When done and media is shown by the parent, keep this pane minimal. */
  mediaHostedByParent?: boolean;
  nowMs?: number;
  /** Library / lightweight progress when no timeline session exists. */
  progressNote?: string | null;
  startedAtMs?: number | null;
  expectedMs?: number;
  /** Persisted library-placeholder steps (Assets generate). */
  progressSteps?: Array<{
    id: string;
    label: string;
    status: "pending" | "active" | "done";
  }> | null;
  errorMessage?: string | null;
  doneMessage?: string | null;
  /** Finished still/video preview for Result (library generates). */
  resultPreviewUrl?: string | null;
  resultMediaKind?: "image" | "video" | null;
};

function providerLabel(generation: AddAssetGeneration): string {
  const server = generation.server?.trim() || generation.provider?.trim();
  if (server === "blue_direct") return "Direct to Blue";
  if (server === "parascene_blue" || server === "parascene") return "Parascene";
  if (server === "replicate") return "Replicate";
  return server || "Generate";
}

/** Result side of dual view — staging, progress, or success with media. */
export function GenerateResultPane({
  phase,
  session = null,
  generation = null,
  mediaHostedByParent = false,
  nowMs,
  progressNote = null,
  startedAtMs = null,
  expectedMs = 60_000,
  progressSteps = null,
  errorMessage = null,
  doneMessage = null,
  resultPreviewUrl = null,
  resultMediaKind = "image",
}: GenerateResultPaneProps) {
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [heldStart, setHeldStart] = useState<number | null>(null);
  const [heldPhase, setHeldPhase] = useState(phase);
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => setClockMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [phase]);
  const tickMs = nowMs && nowMs > 0 ? nowMs : clockMs;
  const fromProps = session?.startedAtMs ?? startedAtMs ?? null;
  const propStart = fromProps && fromProps > 0 ? fromProps : null;
  if (phase !== heldPhase) {
    setHeldPhase(phase);
    setHeldStart(phase === "running" ? (propStart ?? tickMs) : null);
  } else if (phase === "running" && propStart != null && heldStart !== propStart) {
    setHeldStart(propStart);
  }
  if (phase === "running") {
    const started = propStart ?? heldStart ?? tickMs;
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
        ) : progressSteps?.length ? (
          <ul className="generate-result-steps">
            {progressSteps.map((step) => (
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
      "Generation failed.";
    return (
      <div className="generate-result-pane generate-result-pane--error">
        <GenerationErrorStatus message={message} />
        {session?.steps?.length ? (
          <ul className="generate-result-steps">
            {session.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                {step.label}
              </li>
            ))}
          </ul>
        ) : progressSteps?.length ? (
          <ul className="generate-result-steps">
            {progressSteps.map((step) => (
              <li key={step.id} data-status={step.status}>
                {step.label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  if (phase === "done") {
    if (mediaHostedByParent) {
      return null;
    }
    const previewUrl = resultPreviewUrl?.trim() || null;
    const note =
      doneMessage?.trim() ||
      progressNote?.trim() ||
      (generation
        ? `${providerLabel(generation)}${
            generation.model?.trim() ? ` · ${generation.model.trim()}` : ""
          }`
        : "Added to Assets.");
    return (
      <div
        className={`generate-result-pane${previewUrl ? " has-media" : ""}`}
      >
        {previewUrl ? (
          resultMediaKind === "video" ? (
            <video
              className="generate-result-media"
              src={previewUrl}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <img className="generate-result-media" src={previewUrl} alt="" />
          )
        ) : (
          <h3 className="generate-result-title">Generated</h3>
        )}
        <div className="generate-result-footer">
          <p className="muted generate-result-note">{note}</p>
          {generation?.prompt.trim() && !previewUrl ? (
            <p className="generate-result-prompt">{generation.prompt.trim()}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="generate-result-pane">
      <h3 className="generate-result-title">Result</h3>
      <p className="muted generate-result-note">
        Generated media will show here after you run Generate.
      </p>
    </div>
  );
}
