/**
 * Typed ref trays for Video to Video / Refs to Video.
 */

import { useEffect, useState } from "react";
import type { ProjectAsset } from "../../project/types";
import type { GenerateIntentId } from "./previewIntent";
import {
  extraAudioSlotsRemaining,
  H3_R2V_LIMITS,
  previousTimelineVideoAssetId,
  referencePromptTagHint,
  TIMELINE_IMAGE_NEXT,
  TIMELINE_IMAGE_PREVIOUS,
  isTimelineImageRefId,
  timelineImageRefLabel,
  v2vModelNeedsCharacter,
  type GenerateMediaRefs,
  type TimelineAudioMode,
} from "./generateMediaRefs";
import type { TimelineClip } from "../../project/types";
import { GenerateFrameSourcePicker } from "./GenerateFrameSourcePicker";
import {
  peekTimelineFrameSlot,
  type StartFramePreview,
} from "./addAssetStartFrame";

const TIMELINE_AUDIO_FULL_MIX = "__timeline_full_mix__";
const TIMELINE_AUDIO_VOCALS = "__timeline_vocals__";

function AssetSelect({
  label,
  assets,
  disabled,
  onPick,
  emptyLabel,
  excludeIds = [],
}: {
  label: string;
  assets: readonly ProjectAsset[];
  disabled: boolean;
  onPick: (id: string) => void;
  emptyLabel: string;
  excludeIds?: readonly string[];
}) {
  const taken = new Set(excludeIds);
  const available = assets.filter((asset) => !taken.has(asset.id));
  return (
    <label className="add-asset-generate-field">
      <span>{label}</span>
      <select
        className="control"
        disabled={disabled || available.length === 0}
        value=""
        onChange={(event) => {
          const id = event.target.value.trim();
          if (id) onPick(id);
          event.currentTarget.value = "";
        }}
      >
        <option value="">
          {assets.length === 0 ? emptyLabel : `Add ${label.toLowerCase()}…`}
        </option>
        {available.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name || asset.id}
          </option>
        ))}
      </select>
    </label>
  );
}

function RefChips({
  ids,
  assets,
  disabled,
  onRemove,
  startIndex = 1,
}: {
  ids: readonly string[];
  assets: readonly ProjectAsset[];
  disabled: boolean;
  onRemove: (id: string) => void;
  startIndex?: number;
}) {
  if (ids.length === 0) return null;
  const nameOf = (id: string) =>
    timelineImageRefLabel(id) ||
    assets.find((a) => a.id === id)?.name?.trim() ||
    id;
  return (
    <ul className="generate-media-ref-chips">
      {ids.map((id, index) => (
        <li key={`${id}-${index}`}>
          <span>
            {index + startIndex}. {nameOf(id)}
          </span>
          {disabled ? null : (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onRemove(id)}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ImageRefSlot({
  label,
  ids,
  assets,
  previews,
  emptyLabel,
  disabled,
  onChoose,
  onRemove,
}: {
  label: string;
  ids: readonly string[];
  assets: readonly ProjectAsset[];
  previews: Record<string, string | null>;
  emptyLabel: string;
  disabled: boolean;
  onChoose: () => void;
  onRemove: (id: string) => void;
}) {
  const caption =
    ids.length === 0
      ? emptyLabel
      : ids
          .map((id, index) => {
            const name =
              timelineImageRefLabel(id) ||
              assets.find((a) => a.id === id)?.name?.trim() ||
              id;
            return ids.length > 1 ? `${index + 1}. ${name}` : name;
          })
          .join(" · ");
  return (
    <div className="add-asset-generate-field add-asset-generate-frame-field">
      <span>{label}</span>
      {ids.length === 0 ? (
        <p className="muted add-asset-generate-field-placeholder generate-media-ref-empty">
          {emptyLabel}
        </p>
      ) : (
        <ul className="generate-media-ref-thumbs">
          {ids.map((id, index) => {
            const thumb = previews[id];
            const name =
              timelineImageRefLabel(id) ||
              assets.find((a) => a.id === id)?.name?.trim() ||
              id;
            return (
              <li key={`${id}-${index}`}>
                <button
                  type="button"
                  className="generate-media-ref-thumb"
                  disabled={disabled}
                  title={name}
                  onClick={() => {
                    if (!disabled) onChoose();
                  }}
                >
                  {ids.length > 1 ? (
                    <span className="generate-frame-source-asset-order">
                      {index + 1}
                    </span>
                  ) : null}
                  {thumb ? (
                    <img src={thumb} alt="" draggable={false} />
                  ) : (
                    <span className="muted">Image</span>
                  )}
                </button>
                {disabled ? null : (
                  <button
                    type="button"
                    className="btn ghost generate-media-ref-thumb-remove"
                    onClick={() => onRemove(id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="add-asset-generate-frame-slot-actions is-compact">
        <p className="muted add-asset-generate-frame-source-caption">{caption}</p>
        {disabled ? null : (
          <button type="button" className="btn ghost" onClick={onChoose}>
            Choose…
          </button>
        )}
      </div>
    </div>
  );
}

export function GenerateMediaRefsForm({
  intentId,
  modelId,
  refs,
  imageAssets,
  videoAssets,
  audioAssets,
  assetPreviews = {},
  timeline,
  placeholder,
  hasMainAudio = false,
  hasVocalsTrack = false,
  aspectRatio = "16:9",
  disabled,
  onChange,
}: {
  intentId: GenerateIntentId;
  modelId: string | null;
  refs: GenerateMediaRefs;
  imageAssets: readonly ProjectAsset[];
  videoAssets: readonly ProjectAsset[];
  audioAssets: readonly ProjectAsset[];
  assetPreviews?: Record<string, string | null>;
  timeline: readonly TimelineClip[];
  placeholder: TimelineClip;
  hasMainAudio?: boolean;
  hasVocalsTrack?: boolean;
  aspectRatio?: string;
  disabled: boolean;
  onChange: (next: GenerateMediaRefs) => void;
}) {
  const neighborId = previousTimelineVideoAssetId(timeline, placeholder);
  const needsCharacter = v2vModelNeedsCharacter(modelId);
  const isV2v = intentId === "video_to_video";
  const tagHint = referencePromptTagHint(refs);
  const extraAudioLeft = extraAudioSlotsRemaining(refs);
  const showTimelineFullMix =
    hasMainAudio && refs.timelineAudio !== "full_mix";
  const showTimelineVocals =
    hasVocalsTrack && refs.timelineAudio !== "vocals";
  const unpickedAudioAssets = audioAssets.filter(
    (asset) => !refs.referenceAudioAssetIds.includes(asset.id),
  );
  const pickableAudioAssets =
    extraAudioLeft > 0 ? unpickedAudioAssets : [];
  const hasAudioOptions =
    showTimelineFullMix ||
    showTimelineVocals ||
    pickableAudioAssets.length > 0;
  const [picker, setPicker] = useState<"pictures" | "character" | null>(null);
  // Keyed peek result: "loading" is derived from key mismatch instead of a
  // synchronous setState at effect start.
  const peekKey = [
    placeholder.id,
    placeholder.startSec,
    placeholder.endSec,
    aspectRatio ?? "",
  ].join("|");
  const [neighborPeek, setNeighborPeek] = useState<{
    key: string;
    first: StartFramePreview | null;
    last: StartFramePreview | null;
  } | null>(null);
  const neighborPeeking = neighborPeek?.key !== peekKey;
  const neighborPreviews = {
    first: neighborPeek?.key === peekKey ? neighborPeek.first : null,
    last: neighborPeek?.key === peekKey ? neighborPeek.last : null,
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [first, last] = await Promise.all([
        peekTimelineFrameSlot({
          role: "first",
          timeline,
          placeholder,
          aspectRatio,
        }),
        peekTimelineFrameSlot({
          role: "last",
          timeline,
          placeholder,
          aspectRatio,
        }),
      ]);
      if (cancelled) return;
      setNeighborPeek({ key: peekKey, first, last });
    })();
    return () => {
      cancelled = true;
    };
  }, [aspectRatio, peekKey, placeholder, timeline]);

  const picturePreviews: Record<string, string | null> = {
    ...assetPreviews,
    [TIMELINE_IMAGE_PREVIOUS]: neighborPreviews.first?.previewUrl ?? null,
    [TIMELINE_IMAGE_NEXT]: neighborPreviews.last?.previewUrl ?? null,
  };

  const patch = (next: Partial<GenerateMediaRefs>) =>
    onChange({ ...refs, ...next });

  const setTimelineAudio = (next: TimelineAudioMode) => {
    if (next !== "none" && !hasMainAudio) return;
    if (next === "vocals" && !hasVocalsTrack) return;
    const extraCap = H3_R2V_LIMITS.maxAudios - (next === "none" ? 0 : 1);
    patch({
      timelineAudio: next,
      referenceAudioAssetIds: refs.referenceAudioAssetIds.slice(0, extraCap),
    });
  };

  useEffect(() => {
    if (refs.timelineAudio !== "vocals" || hasVocalsTrack) return;
    onChange({ ...refs, timelineAudio: "none" });
  }, [hasVocalsTrack, refs, onChange]);

  const onPickAudio = (value: string) => {
    if (value === TIMELINE_AUDIO_FULL_MIX) {
      setTimelineAudio("full_mix");
      return;
    }
    if (value === TIMELINE_AUDIO_VOCALS) {
      setTimelineAudio("vocals");
      return;
    }
    if (extraAudioLeft <= 0) return;
    patch({
      referenceAudioAssetIds: [
        ...new Set([...refs.referenceAudioAssetIds, value]),
      ].slice(
        0,
        H3_R2V_LIMITS.maxAudios - (refs.timelineAudio === "none" ? 0 : 1),
      ),
    });
  };

  return (
    <section className="add-asset-generate-section">
      <h3>{isV2v ? "Source video" : "References"}</h3>
      {isV2v ? (
        <>
          <p className="muted add-asset-generate-note">
            Driving footage for restyle / control. Optional still is required
            for some models.
          </p>
          <div className="add-asset-generate-frame-slot-actions">
            <p className="muted add-asset-generate-frame-source-caption">
              {refs.inputVideoAssetId
                ? videoAssets.find((a) => a.id === refs.inputVideoAssetId)?.name ||
                  refs.inputVideoAssetId
                : "No source video"}
            </p>
            {neighborId && !disabled ? (
              <button
                type="button"
                className="btn ghost"
                onClick={() => patch({ inputVideoAssetId: neighborId })}
              >
                Use previous clip
              </button>
            ) : null}
          </div>
          <AssetSelect
            label="Assets video"
            assets={videoAssets}
            disabled={disabled}
            excludeIds={
              refs.inputVideoAssetId ? [refs.inputVideoAssetId] : []
            }
            onPick={(id) => patch({ inputVideoAssetId: id })}
            emptyLabel="No project videos"
          />
          <label className="add-asset-generate-field">
            <span>Start offset (seconds)</span>
            <input
              className="control"
              type="number"
              min={0}
              step={0.1}
              disabled={disabled}
              value={refs.startOffsetSeconds || ""}
              placeholder="0"
              onChange={(event) => {
                const n = Number(event.target.value);
                patch({
                  startOffsetSeconds:
                    Number.isFinite(n) && n > 0 ? n : 0,
                });
              }}
            />
          </label>
          {needsCharacter || refs.characterImageAssetId ? (
            <ImageRefSlot
              label={
                needsCharacter
                  ? "Character / start image (required)"
                  : "Character / start image"
              }
              ids={
                refs.characterImageAssetId ? [refs.characterImageAssetId] : []
              }
              assets={imageAssets}
              previews={picturePreviews}
              emptyLabel="Pick a still from the timeline or Assets."
              disabled={disabled}
              onChoose={() => setPicker("character")}
              onRemove={() => patch({ characterImageAssetId: null })}
            />
          ) : null}
        </>
      ) : (
        <>
          <p className="muted add-asset-generate-note">
            MiniMax H3: up to {H3_R2V_LIMITS.maxImages} pictures,{" "}
            {H3_R2V_LIMITS.maxVideos} videos, {H3_R2V_LIMITS.maxAudios} audios.
            Prompt tags follow attachment order
            {tagHint ? `: ${tagHint}` : " (Picture 1, Video 1, Audio 1)."}.
          </p>
          <ImageRefSlot
            label="Pictures"
            ids={refs.referenceImageAssetIds}
            assets={imageAssets}
            previews={picturePreviews}
            emptyLabel={
              imageAssets.length === 0
                ? "Pick a previous/next clip still, or add project images."
                : "Pick stills from the timeline or Assets."
            }
            disabled={disabled}
            onChoose={() => setPicker("pictures")}
            onRemove={(id) =>
              patch({
                referenceImageAssetIds: refs.referenceImageAssetIds.filter(
                  (x) => x !== id,
                ),
              })
            }
          />
          <RefChips
            ids={refs.referenceVideoAssetIds}
            assets={videoAssets}
            disabled={disabled}
            onRemove={(id) =>
              patch({
                referenceVideoAssetIds: refs.referenceVideoAssetIds.filter(
                  (x) => x !== id,
                ),
              })
            }
          />
          <AssetSelect
            label="Videos"
            assets={videoAssets}
            disabled={disabled}
            excludeIds={refs.referenceVideoAssetIds}
            onPick={(id) =>
              patch({
                referenceVideoAssetIds: [
                  ...new Set([...refs.referenceVideoAssetIds, id]),
                ].slice(0, H3_R2V_LIMITS.maxVideos),
              })
            }
            emptyLabel="No project videos"
          />
          <label className="add-asset-generate-field">
            <span>Audio</span>
            <select
              className="control"
              disabled={disabled || !hasAudioOptions}
              value=""
              aria-label="Add audio"
              onChange={(event) => {
                const value = event.target.value.trim();
                if (value) onPickAudio(value);
                event.currentTarget.value = "";
              }}
            >
              <option value="">
                {audioAssets.length === 0 && !hasAudioOptions
                  ? "No project audio"
                  : "Add audio…"}
              </option>
              {showTimelineFullMix ? (
                <option value={TIMELINE_AUDIO_FULL_MIX}>
                  Timeline clip — full mix
                </option>
              ) : null}
              {showTimelineVocals ? (
                <option value={TIMELINE_AUDIO_VOCALS}>
                  Timeline clip — vocals only
                </option>
              ) : null}
              {pickableAudioAssets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name || asset.id}
                </option>
              ))}
            </select>
          </label>
          {refs.timelineAudio !== "none" ||
          refs.referenceAudioAssetIds.length > 0 ? (
            <ul className="generate-media-ref-chips">
              {refs.timelineAudio !== "none" ? (
                <li>
                  <span>
                    1. Timeline clip —{" "}
                    {refs.timelineAudio === "vocals"
                      ? "vocals only"
                      : "full mix"}
                  </span>
                  {disabled ? null : (
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => setTimelineAudio("none")}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ) : null}
              {refs.referenceAudioAssetIds.map((id, index) => {
                const name =
                  audioAssets.find((a) => a.id === id)?.name?.trim() || id;
                const n =
                  (refs.timelineAudio === "none" ? 1 : 2) + index;
                return (
                  <li key={`${id}-${index}`}>
                    <span>
                      {n}. {name}
                    </span>
                    {disabled ? null : (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() =>
                          patch({
                            referenceAudioAssetIds:
                              refs.referenceAudioAssetIds.filter(
                                (x) => x !== id,
                              ),
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </>
      )}
      {picker && !disabled ? (
        <GenerateFrameSourcePicker
          role="first"
          selection={picker === "pictures" ? "multiple" : "single"}
          selectedAssetIds={
            picker === "pictures" ? refs.referenceImageAssetIds : undefined
          }
          maxAssets={
            picker === "pictures" ? H3_R2V_LIMITS.maxImages : undefined
          }
          title={picker === "pictures" ? "Pictures" : "Character image"}
          description={
            picker === "pictures"
              ? `Previous clip, next clip, and Assets stills (up to ${H3_R2V_LIMITS.maxImages}). Order is Picture 1, Picture 2, …`
              : "Choose the previous clip still or a project image."
          }
          current={
            picker === "character" && refs.characterImageAssetId
              ? isTimelineImageRefId(refs.characterImageAssetId)
                ? { kind: "timeline" }
                : { kind: "asset", assetId: refs.characterImageAssetId }
              : { kind: "none" }
          }
          timelinePreview={neighborPreviews.first}
          timelineLoading={neighborPeeking}
          timelineSlots={
            picker === "pictures"
              ? [
                  {
                    role: "first",
                    preview: neighborPreviews.first,
                    loading: neighborPeeking,
                  },
                  {
                    role: "last",
                    preview: neighborPreviews.last,
                    loading: neighborPeeking,
                  },
                ]
              : undefined
          }
          assets={[...imageAssets]}
          assetPreviews={picturePreviews}
          onCancel={() => setPicker(null)}
          onUse={(source) => {
            if (picker === "character") {
              if (source.kind === "timeline") {
                patch({ characterImageAssetId: TIMELINE_IMAGE_PREVIOUS });
              } else if (source.kind === "asset") {
                patch({ characterImageAssetId: source.assetId });
              } else {
                patch({ characterImageAssetId: null });
              }
            }
            setPicker(null);
          }}
          onUseAssets={(ids) => {
            patch({
              referenceImageAssetIds: ids.slice(0, H3_R2V_LIMITS.maxImages),
            });
            setPicker(null);
          }}
        />
      ) : null}
    </section>
  );
}
