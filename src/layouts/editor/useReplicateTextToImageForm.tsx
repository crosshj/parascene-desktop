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
import { DEFAULT_PROJECT_ASPECT_RATIO } from "../../project/aspectRatios";
import { runReplicateTextToImage } from "./addAssetReplicateTextToImage";
import {
  loadReplicateTextToImageModels,
  type ReplicateTextToImageModelOption,
} from "./replicateTextToImageModels";

export type ReplicateTextToImageFormParts = {
  fields: ReactNode;
  footer: ReactNode;
};

export function useReplicateTextToImageForm(
  idPrefix = "replicate-t2i",
): ReplicateTextToImageFormParts {
  const { project, addCreationsToOpenProject } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const [models, setModels] = useState<ReplicateTextToImageModelOption[] | null>(
    null,
  );
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    void loadReplicateTextToImageModels()
      .then((rows) => {
        if (cancelled) return;
        setModels(rows);
        setModelId((prev) => {
          if (prev && rows.some((m) => m.id === prev)) return prev;
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
  }, []);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  const selected = models?.find((m) => m.id === modelId) ?? null;
  const canGenerate =
    !running &&
    Boolean(prompt.trim()) &&
    Boolean(selected) &&
    Boolean(project.id);

  const handleGenerate = async () => {
    if (!selected || running || !prompt.trim() || !project.id) return;
    setRunning(true);
    setError(null);
    setSuccessNote(null);
    setStatus(`Running ${selected.id}…`);
    try {
      const result = await runReplicateTextToImage({
        model: selected,
        prompt,
        projectId: project.id,
        aspectRatio,
        onProgress: (note) => setStatus(note),
      });
      await addCreationsToOpenProject([result.creationId]);
      setStatus(null);
      setSuccessNote("Added image to Assets.");
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const fields = (
    <>
      <section className="add-asset-generate-section">
        <div className="add-asset-generate-callout">
          <p className="muted" style={{ margin: 0 }}>
            Generate a still into Assets. Only Lab-enabled text → image models
            are listed.
          </p>
        </div>
      </section>

      <section className="add-asset-generate-section">
        <h3>Model</h3>
        {modelsError ? (
          <p className="add-asset-generate-error">{modelsError}</p>
        ) : null}
        {models == null ? (
          <p className="muted">Loading enabled models…</p>
        ) : models.length === 0 ? (
          <p className="muted">
            No enabled Replicate text → image models. Enable models in Lab →
            Replicate.
          </p>
        ) : (
          <label className="add-asset-generate-field">
            <span>Enabled model</span>
            <select
              className="control"
              value={selected?.id ?? ""}
              disabled={running}
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
            disabled={running}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the image to generate…"
          />
        </label>
      </section>

      {status ? (
        <section className="add-asset-generate-section">
          <p className="muted add-asset-generate-progress-note">{status}</p>
        </section>
      ) : null}
      {error ? (
        <section className="add-asset-generate-section">
          <p className="add-asset-generate-error" role="alert">
            {error}
          </p>
        </section>
      ) : null}
      {successNote ? (
        <section className="add-asset-generate-section">
          <p className="muted" style={{ margin: 0 }}>
            {successNote}
          </p>
        </section>
      ) : null}
    </>
  );

  const footer = (
    <div className="add-asset-generate-footer preview-intent-footer">
      <button
        type="button"
        className="btn btn-primary editor-add-asset-generate"
        disabled={!canGenerate}
        onClick={() => void handleGenerate()}
      >
        {running ? "Generating…" : "Generate image"}
      </button>
    </div>
  );

  return { fields, footer };
}
