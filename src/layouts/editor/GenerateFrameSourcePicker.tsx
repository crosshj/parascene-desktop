/**
 * Modal picker for generate stills: timeline neighbor, Assets image, or none.
 */

import { useState } from "react";
import type { AddAssetFrameSource, ProjectAsset } from "../../project/types";
import type { StartFramePreview } from "./addAssetStartFrame";

export type GenerateFrameSourcePickerRole = "first" | "last";

function titleForRole(role: GenerateFrameSourcePickerRole): string {
  return role === "last" ? "Last frame" : "First frame";
}

function timelineLabel(role: GenerateFrameSourcePickerRole): string {
  return role === "last" ? "Next clip" : "Previous clip";
}

export function GenerateFrameSourcePicker({
  role,
  current,
  timelinePreview,
  timelineLoading,
  assets,
  assetPreviews,
  mode = "full",
  timelineAllowed = true,
  timelineDisallowReason,
  onCancel,
  onUse,
}: {
  role: GenerateFrameSourcePickerRole;
  current: AddAssetFrameSource;
  timelinePreview: StartFramePreview | null;
  timelineLoading: boolean;
  assets: ProjectAsset[];
  assetPreviews: Record<string, string | null>;
  /** Assets grid only — for library I2I source selection. */
  mode?: "full" | "assets-only";
  /** When false, timeline neighbor cannot be chosen (e.g. no FLF model). */
  timelineAllowed?: boolean;
  timelineDisallowReason?: string;
  onCancel: () => void;
  onUse: (source: AddAssetFrameSource) => void;
}) {
  const assetsOnly = mode === "assets-only";
  const [draft, setDraft] = useState<AddAssetFrameSource>(() =>
    assetsOnly && current.kind !== "asset"
      ? { kind: "asset", assetId: "" }
      : current,
  );
  const currentKey =
    current.kind === "asset" ? `asset:${current.assetId}` : current.kind;
  const [draftKey, setDraftKey] = useState(currentKey);
  if (draftKey !== currentKey) {
    setDraftKey(currentKey);
    setDraft(
      assetsOnly && current.kind !== "asset"
        ? { kind: "asset", assetId: "" }
        : current,
    );
  }

  const timelineReady = Boolean(
    timelinePreview?.previewUrl ||
      timelinePreview?.framePath ||
      timelinePreview?.remoteImageUrl,
  );
  const timelineDisabled =
    !timelineAllowed || (!timelineLoading && !timelineReady);
  const timelineReason = !timelineAllowed
    ? timelineDisallowReason?.trim() ||
      "First + last is not available for the current models."
    : timelinePreview?.note?.trim() ||
      (role === "last"
        ? "No next clip on the timeline."
        : "No previous clip on the timeline.");

  const assetsAllowed = timelineAllowed || role === "first";
  const assetsDisallowReason =
    "First + last is not available for the current models.";

  const canUse = assetsOnly
    ? draft.kind === "asset" &&
      Boolean(draft.assetId.trim()) &&
      assets.some((a) => a.id === draft.assetId)
    : draft.kind === "none"
      ? true
      : draft.kind === "timeline"
        ? timelineAllowed && timelineReady
        : assetsAllowed &&
          Boolean(draft.assetId.trim()) &&
          assets.some((a) => a.id === draft.assetId);

  const title = assetsOnly ? "Source image" : titleForRole(role);
  const description = assetsOnly
    ? "Pick a still from this project's Assets."
    : "Choose a timeline neighbor, a project image, or none.";

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className={
          assetsOnly
            ? "confirm-dialog generate-frame-source-picker is-assets-only"
            : "confirm-dialog generate-frame-source-picker"
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="generate-frame-source-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="generate-frame-source-picker-title">{title}</h2>
        <p className="muted">{description}</p>

        <div className="generate-frame-source-picker-body">
          {!assetsOnly ? (
            <>
          <button
            type="button"
            className={
              draft.kind === "none"
                ? "generate-frame-source-option is-selected"
                : "generate-frame-source-option"
            }
            aria-pressed={draft.kind === "none"}
            onClick={() => setDraft({ kind: "none" })}
          >
            <span className="generate-frame-source-option-copy">
              <span className="generate-frame-source-option-label">None</span>
              <span className="muted generate-frame-source-option-reason">
                Leave this frame unused
              </span>
            </span>
            <span className="generate-frame-source-option-thumb is-empty" aria-hidden>
              <span className="muted">—</span>
            </span>
            {draft.kind === "none" ? (
              <span className="generate-frame-source-check" aria-hidden>
                ✓
              </span>
            ) : null}
          </button>

          <div className="generate-frame-source-timeline">
            <span className="generate-frame-source-section-label">Timeline</span>
            <button
              type="button"
              className={
                draft.kind === "timeline"
                  ? "generate-frame-source-option is-selected"
                  : "generate-frame-source-option"
              }
              disabled={timelineDisabled}
              aria-pressed={draft.kind === "timeline"}
              onClick={() => setDraft({ kind: "timeline" })}
            >
              <span className="generate-frame-source-option-copy">
                <span className="generate-frame-source-option-label">
                  {timelineLabel(role)}
                </span>
                {timelineDisabled ? (
                  <span className="muted generate-frame-source-option-reason">
                    {timelineReason}
                  </span>
                ) : (
                  <span className="muted generate-frame-source-option-reason">
                    Use the neighbor still from the timeline
                  </span>
                )}
              </span>
              <span className="generate-frame-source-option-thumb" aria-hidden>
                {timelineLoading ? (
                  <span className="muted">Loading…</span>
                ) : timelinePreview?.previewUrl ? (
                  <img
                    src={timelinePreview.previewUrl}
                    alt=""
                    draggable={false}
                  />
                ) : (
                  <span className="muted">Unavailable</span>
                )}
              </span>
              {draft.kind === "timeline" ? (
                <span className="generate-frame-source-check" aria-hidden>
                  ✓
                </span>
              ) : null}
            </button>
          </div>
            </>
          ) : null}

          <div className="generate-frame-source-assets">
            <span className="generate-frame-source-section-label">Assets</span>
            {!assetsAllowed ? (
              <p className="muted" style={{ margin: 0 }}>
                {assetsDisallowReason}
              </p>
            ) : assets.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No image assets in this project yet.
              </p>
            ) : (
              <div
                className="generate-frame-source-assets-grid"
                role="listbox"
                aria-label="Project image assets"
              >
                {assets.map((asset) => {
                  const selected =
                    draft.kind === "asset" && draft.assetId === asset.id;
                  const thumb = assetPreviews[asset.id];
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={
                        selected
                          ? "generate-frame-source-asset is-selected"
                          : "generate-frame-source-asset"
                      }
                      title={asset.name}
                      onClick={() =>
                        setDraft({ kind: "asset", assetId: asset.id })
                      }
                    >
                      {thumb ? (
                        <img src={thumb} alt="" draggable={false} />
                      ) : (
                        <span className="muted">Image</span>
                      )}
                      {selected ? (
                        <span className="generate-frame-source-asset-check" aria-hidden>
                          ✓
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canUse}
            onClick={() => onUse(draft)}
          >
            Use
          </button>
        </div>
      </div>
    </div>
  );
}
