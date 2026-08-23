/**
 * Shared state + UI for Parascene credits Image → Image into Assets.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShell } from "../../app/ShellProvider";
import { getCreations } from "../../library/catalogClient";
import { creationPreviewUrl } from "../../library/previewUrl";
import {
  DEFAULT_PROJECT_ASPECT_RATIO,
  projectAspectCss,
} from "../../project/aspectRatios";
import {
  loadGenerationFramePreviews,
  resolveGenerationFramePreviews,
} from "../../project/generationFramePreviews";
import type { AddAssetGeneration } from "../../project/types";
import {
  parasceneStillModelFamilies,
  parasceneResolveStillModel,
} from "./parasceneProductCaps";
import { startLibraryParasceneImageToImage } from "./libraryAssetGenerationStore";
import { GenerateFrameSourcePicker } from "./GenerateFrameSourcePicker";
import {
  CloneButton,
  GenerateTargetButton,
} from "./AddAssetIntentFooter";
import type { LibraryGenerateUiState } from "./generateDualView";
import type { ProjectAsset } from "../../project/types";
import { reviewGenerationIdentity } from "../../project/desktopAddAssetGeneration";

const EMPTY_IMAGE_ASSETS: ProjectAsset[] = [];

export type ParasceneImageToImageFormParts = {
  fields: ReactNode;
  generateAction?: ReactNode;
  cloneAction?: ReactNode;
};

export type UseParasceneImageToImageFormOpts = {
  idPrefix?: string;
  locked?: boolean;
  hideInlineProgress?: boolean;
  imageAssets?: ProjectAsset[];
  onGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  onGenerateNew?: () => void;
  /** Exit + slot and select the reserved placeholder asset in the editor. */
  onLibraryAssetGenerationStarted?: (assetId: string) => void;
  initialPrompt?: string;
  initialModelId?: string;
  initialSourceAssetId?: string;
  /**
   * Finished generation under review — start stills use the shared
   * generation-frame helper (same path as I2V Form).
   */
  reviewGeneration?: AddAssetGeneration | null;
  /** Reuse an existing Generate → Assets placeholder id. */
  placeholderId?: string;
};

export function useParasceneImageToImageForm(
  opts: UseParasceneImageToImageFormOpts = {},
): ParasceneImageToImageFormParts {
  const idPrefix = opts.idPrefix ?? "parascene-i2i";
  const locked = opts.locked ?? false;
  const imageAssets = opts.imageAssets ?? EMPTY_IMAGE_ASSETS;
  const onGenerateStateChange = opts.onGenerateStateChange;
  const onGenerateNew = opts.onGenerateNew;
  const initialPrompt = opts.initialPrompt ?? "";
  const initialModelId = opts.initialModelId?.trim() || null;
  const reviewGeneration = opts.reviewGeneration ?? null;
  const reviewFrames = resolveGenerationFramePreviews(reviewGeneration);
  const initialSource =
    opts.initialSourceAssetId?.trim() ||
    reviewFrames.startAssetId ||
    null;
  const placeholderId = opts.placeholderId?.trim() || undefined;

  const { project } = useShell();
  const aspectRatio = project.aspectRatio ?? DEFAULT_PROJECT_ASPECT_RATIO;

  const [modelFamilies] = useState(() =>
    parasceneStillModelFamilies("image_to_image"),
  );
  const models = modelFamilies.flatMap((g) => g.models);
  const [modelId, setModelId] = useState<string | null>(() => {
    if (initialModelId) {
      const hit = parasceneResolveStillModel("image_to_image", initialModelId);
      if (hit) return hit.id;
    }
    return models[0]?.id ?? null;
  });
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(
    initialSource,
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [doneLocked, setDoneLocked] = useState(false);
  const [assetPreviews, setAssetPreviews] = useState<
    Record<string, string | null>
  >({});
  const [asyncReviewStartPreview, setAsyncReviewStartPreview] = useState<{
    identity: string;
    url: string | null;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const fieldsLocked = locked || doneLocked;
  const selected =
    (modelId ? parasceneResolveStillModel("image_to_image", modelId) : null) ??
    null;
  const canGenerate =
    !fieldsLocked &&
    Boolean(prompt.trim()) &&
    Boolean(selected?.id) &&
    Boolean(sourceAssetId) &&
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

  const reviewIdentity = reviewGenerationIdentity(reviewGeneration);
  const lockedReviewKey =
    locked && reviewIdentity
      ? [
          reviewIdentity,
          reviewGeneration?.prompt ?? initialPrompt,
          reviewGeneration?.model?.trim() || initialModelId || "",
          reviewGeneration?.startFrameAssetId?.trim() || initialSource || "",
        ].join("\0")
      : "";
  const [appliedLockedReviewKey, setAppliedLockedReviewKey] =
    useState(lockedReviewKey);
  if (locked && lockedReviewKey && lockedReviewKey !== appliedLockedReviewKey) {
    setAppliedLockedReviewKey(lockedReviewKey);
    setPrompt(reviewGeneration?.prompt ?? initialPrompt);
    const model =
      reviewGeneration?.model?.trim() || initialModelId?.trim() || "";
    if (model) {
      const hit = parasceneResolveStillModel("image_to_image", model);
      if (hit) setModelId(hit.id);
    }
    const source =
      reviewGeneration?.startFrameAssetId?.trim() ||
      initialSource?.trim() ||
      "";
    setSourceAssetId(source || null);
  }

  useEffect(() => {
    if (fieldsLocked || imageAssets.length === 0) return;
    let cancelled = false;
    const ids = imageAssets.map((asset) => asset.id);
    void (async () => {
      const rows = await getCreations(ids);
      if (cancelled) return;
      const next: Record<string, string | null> = {};
      for (const row of rows) {
        next[row.id] = creationPreviewUrl(row);
      }
      setAssetPreviews(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [fieldsLocked, imageAssets]);

  // Locked review: load start still only when sync preview is missing.
  useEffect(() => {
    if (!reviewGeneration || !reviewIdentity) return;
    const sync = resolveGenerationFramePreviews(reviewGeneration);
    if (sync.startPreviewUrl || !sync.startAssetId) return;
    let cancelled = false;
    void loadGenerationFramePreviews(reviewGeneration).then((loaded) => {
      if (cancelled) return;
      setAsyncReviewStartPreview({
        identity: reviewIdentity,
        url: loaded.startPreviewUrl,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [reviewGeneration, reviewIdentity]);

  const sourceAsset =
    sourceAssetId != null
      ? imageAssets.find((asset) => asset.id === sourceAssetId)
      : null;
  const asyncReviewStartPreviewUrl =
    asyncReviewStartPreview?.identity === reviewIdentity
      ? asyncReviewStartPreview.url
      : null;
  const reviewStartLoading = Boolean(
    reviewGeneration &&
      !reviewFrames.startPreviewUrl &&
      reviewFrames.startAssetId &&
      !asyncReviewStartPreviewUrl,
  );
  const sourcePreviewUrl =
    reviewFrames.startPreviewUrl ??
    asyncReviewStartPreviewUrl ??
    (sourceAssetId != null ? assetPreviews[sourceAssetId] : null);
  const fieldsInteractive = !fieldsLocked;

  const handleGenerateNew = () => {
    setDoneLocked(false);
    reportState({ phase: "pre_gen", progressNote: "" });
    onGenerateNew?.();
  };

  const handleGenerate = () => {
    if (
      !selected ||
      fieldsLocked ||
      !prompt.trim() ||
      !sourceAssetId ||
      !project.id
    ) {
      return;
    }
    startLibraryParasceneImageToImage({
      projectId: project.id,
      projectTitle: project.title,
      imagesGroupId: project.imagesGroupId,
      videosGroupId: project.videosGroupId,
      aspectRatio,
      prompt,
      modelId: selected.id,
      route: selected,
      sourceCreationId: sourceAssetId,
      placeholderId,
    });
  };

  const fields = (
    <>
      <section className="add-asset-generate-section">
        <h3>Source image</h3>
        {imageAssets.length === 0 && !sourceAssetId ? (
          <p className="muted add-asset-generate-note">
            Add stills to Assets to use as the source image.
          </p>
        ) : (
          <div className="add-asset-generate-field add-asset-generate-frame-field">
            <div
              className="add-asset-generate-frame-preview"
              style={{ aspectRatio: projectAspectCss(aspectRatio) }}
            >
              {sourcePreviewUrl ? (
                <img
                  src={sourcePreviewUrl}
                  alt="Source image"
                  draggable={false}
                />
              ) : (
                <p className="muted add-asset-generate-field-placeholder">
                  {!sourceAssetId
                    ? "No source image selected."
                    : reviewStartLoading
                      ? "Selected image is not available yet."
                      : "Selected image could not be loaded."}
                </p>
              )}
            </div>
            <div className="add-asset-generate-frame-slot-actions is-compact">
              <p className="muted add-asset-generate-frame-source-caption">
                {sourceAsset?.name?.trim() ||
                  sourceAssetId ||
                  "Pick a still from Assets."}
              </p>
              {fieldsInteractive ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setPickerOpen(true)}
                >
                  Choose…
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>
      <section className="add-asset-generate-section">
        <h3>Model</h3>
        {models.length === 0 ? (
          <p className="muted">
            No Parascene image-to-image models in capabilities snapshot.
          </p>
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
            placeholder="Describe the edit…"
          />
        </label>
      </section>
      {pickerOpen ? (
        <GenerateFrameSourcePicker
          mode="assets-only"
          role="first"
          current={
            sourceAssetId
              ? { kind: "asset", assetId: sourceAssetId }
              : { kind: "none" }
          }
          timelinePreview={null}
          timelineLoading={false}
          assets={imageAssets}
          assetPreviews={assetPreviews}
          onCancel={() => setPickerOpen(false)}
          onUse={(source) => {
            if (source.kind === "asset") {
              setSourceAssetId(source.assetId);
            }
            setPickerOpen(false);
          }}
        />
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
        running={false}
        onClick={() => handleGenerate()}
      />
    ) : null;

  return { fields, generateAction, cloneAction };
}
