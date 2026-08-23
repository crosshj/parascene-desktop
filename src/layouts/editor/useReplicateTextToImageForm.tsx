/**
 * Shared state + UI parts for Replicate text → image into Assets.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShell } from "../../app/ShellProvider";
import {
  applyManifest,
  getCreation,
} from "../../library/catalogClient";
import {
  creationDetailUrl,
  creationPreviewUrl,
} from "../../library/previewUrl";
import { DEFAULT_PROJECT_ASPECT_RATIO } from "../../project/aspectRatios";
import {
  creationUpsertWithAddAssetGeneration,
  makeTextToImageGeneration,
} from "../../project/desktopAddAssetGeneration";
import { runReplicateTextToImage } from "./addAssetReplicateTextToImage";
import {
  loadReplicateTextToImageModels,
  type ReplicateTextToImageModelOption,
} from "./replicateTextToImageModels";
import type { LibraryGenerateUiState } from "./generateDualView";
import { CloneButton, GenerateTargetButton } from "./AddAssetIntentFooter";

export type ReplicateTextToImageFormParts = {
  fields: ReactNode;
  generateAction?: ReactNode;
  cloneAction?: ReactNode;
};

export type UseReplicateTextToImageFormOpts = {
  idPrefix?: string;
  locked?: boolean;
  hideInlineProgress?: boolean;
  onGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  onGenerateNew?: () => void;
  initialPrompt?: string;
  initialModelId?: string;
};

export function useReplicateTextToImageForm(
  idPrefixOrOpts: string | UseReplicateTextToImageFormOpts = "replicate-t2i",
): ReplicateTextToImageFormParts {
  const opts: UseReplicateTextToImageFormOpts =
    typeof idPrefixOrOpts === "string"
      ? { idPrefix: idPrefixOrOpts }
      : idPrefixOrOpts;
  const idPrefix = opts.idPrefix ?? "replicate-t2i";
  const locked = opts.locked ?? false;
  const hideInlineProgress = opts.hideInlineProgress ?? false;
  const onGenerateStateChange = opts.onGenerateStateChange;
  const onGenerateNew = opts.onGenerateNew;
  const initialPrompt = opts.initialPrompt ?? "";
  const initialModelId = opts.initialModelId?.trim() || null;

  const { project, addCreationsToOpenProject } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const [models, setModels] = useState<ReplicateTextToImageModelOption[] | null>(
    null,
  );
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(initialModelId);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [doneLocked, setDoneLocked] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const fieldsLocked = locked || running || doneLocked;
  const reviewModelId = modelId?.trim() || initialModelId || "";

  const reportState = (state: LibraryGenerateUiState) => {
    onGenerateStateChange?.(state);
  };

  useEffect(() => {
    if (fieldsLocked && reviewModelId) return;
    let cancelled = false;
    void loadReplicateTextToImageModels()
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        setModelId((prev) => {
          const preferred = prev || initialModelId;
          if (preferred && rows.some((m) => m.id === preferred)) {
            return preferred;
          }
          return rows[0]?.id ?? null;
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setModels([]);
        setModelsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [fieldsLocked, reviewModelId, initialModelId]);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  const lockedReviewKey = locked
    ? `${initialPrompt}\0${initialModelId ?? ""}`
    : "";
  const [appliedLockedReviewKey, setAppliedLockedReviewKey] =
    useState(lockedReviewKey);
  if (locked && lockedReviewKey !== appliedLockedReviewKey) {
    setAppliedLockedReviewKey(lockedReviewKey);
    setPrompt(initialPrompt);
    if (initialModelId) setModelId(initialModelId);
  }

  const selected = models?.find((m) => m.id === modelId) ?? null;
  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt.trim()) &&
    Boolean(selected || modelId) &&
    Boolean(project.id);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    setSuccessNote(null);
    setError(null);
    setStatus(null);
    reportState({ phase: "pre_gen", progressNote: "" });
    onGenerateNew?.();
  };

  const handleGenerate = async () => {
    if (!selected || fieldsLocked || !prompt.trim() || !project.id) return;
    const started = Date.now();
    setRunning(true);
    setError(null);
    setSuccessNote(null);
    setStatus(`Running ${selected.id}…`);
    reportState({
      phase: "running",
      progressNote: `Running ${selected.id}…`,
      startedAtMs: started,
    });
    try {
      const result = await runReplicateTextToImage({
        model: selected,
        prompt,
        projectId: project.id,
        aspectRatio,
        onProgress: (note) => {
          setStatus(note);
          reportState({
            phase: "running",
            progressNote: note,
            startedAtMs: started,
          });
        },
      });
      await addCreationsToOpenProject([result.creationId]);
      let previewUrl: string | null = null;
      try {
        const creation = await getCreation(result.creationId);
        previewUrl =
          creationDetailUrl(creation) ?? creationPreviewUrl(creation) ?? null;
        await applyManifest([
          creationUpsertWithAddAssetGeneration(
            creation,
            makeTextToImageGeneration({
              prompt,
              creationId: result.creationId,
              model: selected.id,
              server: "replicate",
            }),
          ),
        ]);
      } catch {
        // Provenance stamp is best-effort.
        try {
          const creation = await getCreation(result.creationId);
          previewUrl =
            creationDetailUrl(creation) ??
            creationPreviewUrl(creation) ??
            null;
        } catch {
          /* preview optional */
        }
      }
      setStatus(null);
      setSuccessNote("Added image to Assets.");
      setDoneLocked(true);
      reportState({
        phase: "done",
        progressNote: "Added image to Assets.",
        startedAtMs: started,
        resultCreationId: result.creationId,
        resultPreviewUrl: previewUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus(null);
      setError(message);
      reportState({
        phase: "error",
        progressNote: "",
        errorMessage: message,
        startedAtMs: started,
      });
    } finally {
      setRunning(false);
    }
  };

  const fields = (
    <>
      <section className="add-asset-generate-section">
        {modelsError ? (
          <p className="add-asset-generate-error">{modelsError}</p>
        ) : null}
        {fieldsLocked && reviewModelId && models == null ? (
          <label className="add-asset-generate-field">
            <span>Model</span>
            <select className="control" value={reviewModelId} disabled>
              <option value={reviewModelId}>{reviewModelId}</option>
            </select>
          </label>
        ) : models == null ? (
          <p className="muted">Loading models…</p>
        ) : models.length === 0 ? (
          <p className="muted">
            No enabled Replicate text → image models. Enable models in Lab →
            Replicate.
          </p>
        ) : (
          <label className="add-asset-generate-field">
            <span>Model</span>
            <select
              className="control"
              value={selected?.id ?? reviewModelId}
              disabled={fieldsLocked}
              onChange={(event) => setModelId(event.target.value || null)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section className="add-asset-generate-section">
        <label
          className="add-asset-generate-prompt-label"
          htmlFor={`${idPrefix}-prompt`}
        >
          <span>Prompt</span>
          <textarea
            id={`${idPrefix}-prompt`}
            ref={promptRef}
            className="add-asset-generate-prompt is-auto-size"
            rows={2}
            value={prompt}
            disabled={fieldsLocked}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the image to generate…"
          />
        </label>
      </section>

      {!hideInlineProgress && status ? (
        <section className="add-asset-generate-section">
          <p className="muted add-asset-generate-progress-note">{status}</p>
        </section>
      ) : null}
      {(!hideInlineProgress || Boolean(error && !running)) && error ? (
        <section className="add-asset-generate-section">
          <p className="add-asset-generate-error" role="alert">
            {error}
          </p>
        </section>
      ) : null}
      {!hideInlineProgress && successNote ? (
        <section className="add-asset-generate-section">
          <p className="muted" style={{ margin: 0 }}>
            {successNote}
          </p>
        </section>
      ) : null}
    </>
  );

  const cloneAction =
    onGenerateNew && (doneLocked || locked) ? (
      <CloneButton
        onClick={doneLocked ? handleGenerateNew : () => onGenerateNew?.()}
      />
    ) : null;

  const generateAction =
    !doneLocked && !(locked && onGenerateNew) ? (
      <GenerateTargetButton
        target="Assets"
        disabled={!canGenerate}
        running={running}
        onClick={() => void handleGenerate()}
      />
    ) : null;

  return { fields, generateAction, cloneAction };
}
