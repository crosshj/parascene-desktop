/**
 * Shared state + UI for Parascene credits Text → Image into Assets.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShell } from "../../app/ShellProvider";
import { DEFAULT_PROJECT_ASPECT_RATIO } from "../../project/aspectRatios";
import {
  parasceneStillModelFamilies,
  parasceneResolveStillModel,
} from "./parasceneProductCaps";
import { startLibraryParasceneTextToImage } from "./libraryAssetGenerationStore";
import { CloneButton, GenerateTargetButton } from "./AddAssetIntentFooter";
import type { LibraryGenerateUiState } from "./generateDualView";

export type ParasceneTextToImageFormParts = {
  fields: ReactNode;
  generateAction?: ReactNode;
  cloneAction?: ReactNode;
};

export type UseParasceneTextToImageFormOpts = {
  idPrefix?: string;
  locked?: boolean;
  hideInlineProgress?: boolean;
  onGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  onGenerateNew?: () => void;
  /** Exit + slot and select the reserved placeholder asset in the editor. */
  onLibraryAssetGenerationStarted?: (assetId: string) => void;
  initialPrompt?: string;
  initialModelId?: string;
  /** Reuse an existing Generate → Assets placeholder id. */
  placeholderId?: string;
};

export function useParasceneTextToImageForm(
  opts: UseParasceneTextToImageFormOpts = {},
): ParasceneTextToImageFormParts {
  const idPrefix = opts.idPrefix ?? "parascene-t2i";
  const locked = opts.locked ?? false;
  const onGenerateStateChange = opts.onGenerateStateChange;
  const onGenerateNew = opts.onGenerateNew;
  const initialPrompt = opts.initialPrompt ?? "";
  const initialModelId = opts.initialModelId?.trim() || null;
  const placeholderId = opts.placeholderId?.trim() || undefined;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const [modelFamilies] = useState(() =>
    parasceneStillModelFamilies("text_to_image"),
  );
  const models = modelFamilies.flatMap((g) => g.models);
  const [modelId, setModelId] = useState<string | null>(() => {
    if (initialModelId) {
      const hit = parasceneResolveStillModel("text_to_image", initialModelId);
      if (hit) return hit.id;
    }
    return models[0]?.id ?? null;
  });
  const [prompt, setPrompt] = useState(initialPrompt);
  const [doneLocked, setDoneLocked] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const fieldsLocked = locked || doneLocked;
  const selected =
    (modelId ? parasceneResolveStillModel("text_to_image", modelId) : null) ??
    null;
  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt.trim()) &&
    Boolean(selected?.id) &&
    Boolean(project.id);

  const reportState = (state: LibraryGenerateUiState) => {
    onGenerateStateChange?.(state);
  };

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [prompt]);

  const handleGenerateNew = () => {
    setDoneLocked(false);
    reportState({ phase: "pre_gen", progressNote: "" });
    onGenerateNew?.();
  };

  const handleGenerate = () => {
    if (!selected || fieldsLocked || !prompt.trim() || !project.id) return;
    startLibraryParasceneTextToImage({
      projectId: project.id,
      projectTitle: project.title,
      imagesGroupId: project.imagesGroupId,
      videosGroupId: project.videosGroupId,
      aspectRatio,
      prompt,
      modelId: selected.id,
      route: selected,
      placeholderId,
    });
  };

  const fields = (
    <>
      <section className="add-asset-generate-section">
        <h3>Model</h3>
        {models.length === 0 ? (
          <p className="muted">No Parascene image models in capabilities snapshot.</p>
        ) : (
          <label className="add-asset-generate-field">
            <span>Parascene model</span>
            <select
              className="control"
              value={modelId ?? ""}
              disabled={fieldsLocked}
              onChange={(e) => setModelId(e.target.value || null)}
            >
              {modelFamilies.map((group) => (
                <optgroup key={group.family} label={group.label}>
                  {group.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
      </section>
      <section className="add-asset-generate-section">
        <h3>Prompt</h3>
        <label className="add-asset-generate-field">
          <span className="sr-only">Prompt</span>
          <textarea
            ref={promptRef}
            id={`${idPrefix}-prompt`}
            className="control"
            rows={3}
            value={prompt}
            disabled={fieldsLocked}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the image…"
          />
        </label>
      </section>
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
        running={false}
        onClick={() => handleGenerate()}
      />
    ) : null;

  return { fields, generateAction, cloneAction };
}
