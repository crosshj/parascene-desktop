/**
 * Modal picker for generate stills: timeline neighbor, Assets image, or none.
 */

import { useState } from "react";
import type { AddAssetFrameSource, ProjectAsset } from "../../project/types";
import type { StartFramePreview } from "./addAssetStartFrame";
import {
  isTimelineImageRefId,
  TIMELINE_IMAGE_NEXT,
  TIMELINE_IMAGE_PREVIOUS,
} from "./generateMediaRefs";

export type GenerateFrameSourcePickerRole = "first" | "last";

export type TimelineNeighborSlot = {
  role: GenerateFrameSourcePickerRole;
  preview: StartFramePreview | null;
  loading: boolean;
};

function titleForRole(role: GenerateFrameSourcePickerRole): string {
  return role === "last" ? "Last frame" : "First frame";
}

function timelineLabel(role: GenerateFrameSourcePickerRole): string {
  return role === "last" ? "Next clip" : "Previous clip";
}

function timelineSlotId(role: GenerateFrameSourcePickerRole): string {
  return role === "last" ? TIMELINE_IMAGE_NEXT : TIMELINE_IMAGE_PREVIOUS;
}

function timelineSlotReady(preview: StartFramePreview | null): boolean {
  return Boolean(
    preview?.previewUrl || preview?.framePath || preview?.remoteImageUrl,
  );
}

export function GenerateFrameSourcePicker({
  role,
  current,
  timelinePreview,
  timelineLoading,
  assets,
  assetPreviews,
  mode = "full",
  selection = "single",
  selectedAssetIds,
  maxAssets,
  title: titleOverride,
  description: descriptionOverride,
  timelineAllowed = true,
  timelineDisallowReason,
  timelineSlots,
  onCancel,
  onUse,
  onUseAssets,
}: {
  role: GenerateFrameSourcePickerRole;
  current: AddAssetFrameSource;
  timelinePreview: StartFramePreview | null;
  timelineLoading: boolean;
  assets: ProjectAsset[];
  assetPreviews: Record<string, string | null>;
  /** Assets grid only — for library I2I source selection. */
  mode?: "full" | "assets-only";
  /** Multiple Assets picks (Refs to Video pictures). */
  selection?: "single" | "multiple";
  selectedAssetIds?: readonly string[];
  maxAssets?: number;
  title?: string;
  description?: string;
  /** When false, timeline neighbor cannot be chosen (e.g. no FLF model). */
  timelineAllowed?: boolean;
  timelineDisallowReason?: string;
  /** Previous + next clip as addable stills (Refs to Video pictures). */
  timelineSlots?: readonly TimelineNeighborSlot[];
  onCancel: () => void;
  onUse: (source: AddAssetFrameSource) => void;
  onUseAssets?: (assetIds: string[]) => void;
}) {
  const assetsOnly = mode === "assets-only";
  const neighborSlots = timelineSlots ?? [];
  const refsPictures = neighborSlots.length > 0 && selection === "multiple";
  const multi = selection === "multiple";
  const [draft, setDraft] = useState<AddAssetFrameSource>(() =>
    assetsOnly && current.kind !== "asset"
      ? { kind: "asset", assetId: "" }
      : current,
  );
  const [draftIds, setDraftIds] = useState<string[]>(() =>
    (selectedAssetIds ?? []).filter(
      (id) => assets.some((a) => a.id === id) || isTimelineImageRefId(id),
    ),
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

  const assetsAllowed = timelineAllowed || role === "first";
  const assetsDisallowReason =
    "First + last is not available for the current models.";

  const toggleDraftId = (id: string) => {
    setDraftIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (typeof maxAssets === "number" && prev.length >= maxAssets) return prev;
      return [...prev, id];
    });
  };

  const canUse = multi
    ? true
    : assetsOnly
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

  const title =
    titleOverride ?? (assetsOnly ? "Source image" : titleForRole(role));
  const description =
    descriptionOverride ??
    (assetsOnly
      ? "Pick a still from this project's Assets."
      : "Choose a timeline neighbor, a project image, or none.");

  const renderTimelineButton = (
    slotRole: GenerateFrameSourcePickerRole,
    preview: StartFramePreview | null,
    loading: boolean,
  ) => {
    const id = timelineSlotId(slotRole);
    const ready = timelineSlotReady(preview);
    const blocked = !multi && !timelineAllowed;
    const disabled = blocked || (!loading && !ready);
    const selected = multi
      ? draftIds.includes(id)
      : draft.kind === "timeline" && role === slotRole;
    const reason = blocked
      ? timelineDisallowReason?.trim() ||
        "First + last is not available for the current models."
      : preview?.note?.trim() ||
        (slotRole === "last"
          ? "No next clip on the timeline."
          : "No previous clip on the timeline.");
    const order = multi ? draftIds.indexOf(id) + 1 : 0;
    return (
      <button
        key={slotRole}
        type="button"
        className={
          selected
            ? "generate-frame-source-option is-selected"
            : "generate-frame-source-option"
        }
        disabled={disabled && !selected}
        aria-pressed={selected}
        onClick={() => {
          if (disabled && !selected) return;
          if (multi) {
            toggleDraftId(id);
            return;
          }
          setDraft({ kind: "timeline" });
        }}
      >
        <span className="generate-frame-source-option-copy">
          <span className="generate-frame-source-option-label">
            {timelineLabel(slotRole)}
          </span>
          {disabled ? (
            <span className="muted generate-frame-source-option-reason">
              {reason}
            </span>
          ) : (
            <span className="muted generate-frame-source-option-reason">
              Use the neighbor still from the timeline
            </span>
          )}
        </span>
        <span className="generate-frame-source-option-thumb" aria-hidden>
          {loading ? (
            <span className="muted">Loading…</span>
          ) : preview?.previewUrl ? (
            <img src={preview.previewUrl} alt="" draggable={false} />
          ) : (
            <span className="muted">Unavailable</span>
          )}
        </span>
        {order > 0 ? (
          <span className="generate-frame-source-asset-order">{order}</span>
        ) : null}
        {selected ? (
          <span className="generate-frame-source-check" aria-hidden>
            ✓
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={onCancel}
    >
      <div
        className={
          assetsOnly || refsPictures
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
          {refsPictures ? (
            <div className="generate-frame-source-timeline">
              <span className="generate-frame-source-section-label">
                Timeline
              </span>
              {neighborSlots.map((slot) =>
                renderTimelineButton(slot.role, slot.preview, slot.loading),
              )}
            </div>
          ) : !assetsOnly ? (
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
            {renderTimelineButton(role, timelinePreview, timelineLoading)}
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
                  const selected = multi
                    ? draftIds.includes(asset.id)
                    : draft.kind === "asset" && draft.assetId === asset.id;
                  const atMax =
                    multi &&
                    typeof maxAssets === "number" &&
                    draftIds.length >= maxAssets &&
                    !selected;
                  const thumb = assetPreviews[asset.id];
                  const order = multi ? draftIds.indexOf(asset.id) + 1 : 0;
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={atMax}
                      className={
                        selected
                          ? "generate-frame-source-asset is-selected"
                          : "generate-frame-source-asset"
                      }
                      title={asset.name}
                      onClick={() => {
                        if (multi) {
                          setDraftIds((prev) =>
                            prev.includes(asset.id)
                              ? prev.filter((id) => id !== asset.id)
                              : [...prev, asset.id],
                          );
                          return;
                        }
                        setDraft({ kind: "asset", assetId: asset.id });
                      }}
                    >
                      {order > 0 ? (
                        <span className="generate-frame-source-asset-order">
                          {order}
                        </span>
                      ) : null}
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
            onClick={() => {
              if (multi) {
                onUseAssets?.(draftIds);
                return;
              }
              onUse(draft);
            }}
          >
            Use
          </button>
        </div>
      </div>
    </div>
  );
}
