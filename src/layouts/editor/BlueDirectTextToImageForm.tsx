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
import { runBlueDirectTextToImage } from "./addAssetBlueDirectGenerate";
import {
  loadBlueStillModels,
  pickBlueStillModel,
  type BlueStillModelOption,
} from "./blueStillModels";
import type { LibraryGenerateUiState } from "./generateDualView";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AddAssetIntentFooter, CloneButton, GenerateTargetButton } from "./AddAssetIntentFooter";

type BlueDirectTextToImageFormProps = {
  locked?: boolean;
  hideInlineProgress?: boolean;
  onGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  onGenerateNew?: () => void;
  /** Seed values for review / Generate new fork. */
  initialPrompt?: string;
  initialModelId?: string;
  renderFooter?: (parts: {
    generateAction?: ReactNode;
    cloneAction?: ReactNode;
  }) => ReactNode;
};

export function BlueDirectTextToImageForm({
  locked = false,
  hideInlineProgress = false,
  onGenerateStateChange,
  onGenerateNew,
  initialPrompt = "",
  initialModelId,
  renderFooter,
}: BlueDirectTextToImageFormProps) {
  const { project, addCreationsToOpenProject } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;
  const [models, setModels] = useState<BlueStillModelOption[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(
    initialModelId?.trim() || null,
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [doneLocked, setDoneLocked] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const fieldsLocked = locked || running || doneLocked;
  const reviewModelId = modelId?.trim() || initialModelId?.trim() || "";

  const reportState = (state: LibraryGenerateUiState) => {
    onGenerateStateChange?.(state);
  };

  useEffect(() => {
    if (fieldsLocked && reviewModelId) return;
    let cancelled = false;
    void loadBlueStillModels("text2image")
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        setModelsError(null);
        setModelId(
          (prev) =>
            pickBlueStillModel(rows, prev ?? initialModelId)?.id ?? null,
        );
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

  const selected = models?.find((m) => m.id === modelId) ?? null;
  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt.trim()) &&
    Boolean(selected?.id || modelId) &&
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
    const model = selected?.id ?? modelId;
    if (!canGenerate || !project.id || !model) return;
    const started = Date.now();
    setRunning(true);
    setError(null);
    setSuccessNote(null);
    setStatus("Running Direct to Blue…");
    reportState({
      phase: "running",
      progressNote: "Running Direct to Blue…",
      startedAtMs: started,
    });
    try {
      const result = await runBlueDirectTextToImage({
        prompt,
        aspectRatio,
        projectId: project.id,
        model,
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
              model,
              server: "blue_direct",
            }),
          ),
        ]);
      } catch {
        // Provenance stamp is best-effort; image is already in Assets.
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
      setSuccessNote("Added image to Assets (local-only).");
      setDoneLocked(true);
      reportState({
        phase: "done",
        progressNote: "Added image to Assets (local-only).",
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

  return (
    <>
      <section className="add-asset-generate-section">
        <h3>Model</h3>
        {modelsError ? (
          <p className="add-asset-generate-error">{modelsError}</p>
        ) : null}
        {fieldsLocked && reviewModelId && models == null ? (
          <label className="add-asset-generate-field">
            <span>Blue model</span>
            <select className="control" value={reviewModelId} disabled>
              <option value={reviewModelId}>{reviewModelId}</option>
            </select>
          </label>
        ) : models == null ? (
          <p className="muted">Loading Blue models…</p>
        ) : models.length === 0 ? (
          <p className="muted">
            No text-to-image models from Blue. Check Settings → Blue
            credentials.
          </p>
        ) : (
          <label className="add-asset-generate-field">
            <span>Blue model</span>
            <select
              className="control"
              value={selected?.id ?? reviewModelId}
              disabled={fieldsLocked}
              onChange={(event) => setModelId(event.target.value || null)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id} title={m.hint}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      <section className="add-asset-generate-section">
        <h3>Prompt</h3>
        <textarea
          ref={promptRef}
          className="add-asset-generate-prompt"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe the image…"
          disabled={fieldsLocked}
        />
      </section>
      {!hideInlineProgress && status ? (
        <p className="muted" style={{ margin: 0 }}>
          {status}
        </p>
      ) : null}
      {!hideInlineProgress && error ? (
        <p className="add-asset-generate-error" role="alert">
          {error}
        </p>
      ) : null}
      {!hideInlineProgress && successNote ? (
        <p className="muted" style={{ margin: 0 }}>
          {successNote}
        </p>
      ) : null}
      {hideInlineProgress && error && !running ? (
        <p className="add-asset-generate-error" role="alert">
          {error}
        </p>
      ) : null}
      {renderFooter ? (
        renderFooter({ generateAction, cloneAction })
      ) : (
        <AddAssetIntentFooter
          generate={generateAction ?? undefined}
          clone={cloneAction ?? undefined}
          timeline={{ mode: "hidden" }}
        />
      )}
    </>
  );
}
