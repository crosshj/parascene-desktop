import type { BakeInfo } from "../../library/slideshowMedia";
import {
  SELECTION_INTENT_MODES,
  findSelectionIntentMode,
  selectionModeAllowsTimelinePlacement,
  type SelectionIntentModeId,
} from "./previewIntent";
import { ClipDragHandle, ClipPlaceHandle, StagingFields } from "./PreviewStaging";
import type { StagedClipDraft } from "./stagedClip";

type SelectionIntentPanelProps = {
  imageCount: number;
  modeId: SelectionIntentModeId | null;
  onModeChange: (modeId: SelectionIntentModeId) => void;
  /** Present once slideshow mode is chosen and a draft is staged. */
  draft: StagedClipDraft | null;
  sourceDurationSec: number;
  onDraftChange: (draft: StagedClipDraft) => void;
  bakeInfo?: BakeInfo | null;
};

export function SelectionIntentPanel({
  imageCount,
  modeId,
  onModeChange,
  draft,
  sourceDurationSec,
  onDraftChange,
  bakeInfo = null,
}: SelectionIntentPanelProps) {
  const selected = findSelectionIntentMode(modeId);
  const canPlace = selectionModeAllowsTimelinePlacement(modeId);
  const showSlideshowConfig =
    modeId === "slideshow" && draft?.kind === "slideshow";

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      aria-label="Choose what to do with selection"
    >
      <div className="add-asset-generate-body">
        <header className="preview-intent-header">
          <h2 className="preview-intent-title">
            Selection · {imageCount} images
          </h2>
          <p className="muted preview-intent-lede">
            Choose what to do with this selection before placing it on the
            timeline.
          </p>
        </header>

        <section className="add-asset-generate-section">
          <h3>Mode</h3>
          <div className="preview-intent-choice-grid" role="list">
            {SELECTION_INTENT_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="listitem"
                className={`preview-intent-choice${
                  modeId === m.id ? " is-selected" : ""
                }`}
                aria-pressed={modeId === m.id}
                onClick={() => onModeChange(m.id)}
              >
                <span className="preview-intent-choice-label">
                  {m.label}
                  {!m.wired ? (
                    <span className="preview-intent-badge">Soon</span>
                  ) : null}
                </span>
                <span className="muted preview-intent-choice-desc">
                  {m.description}
                </span>
              </button>
            ))}
          </div>
        </section>

        {selected && !selected.wired ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout">
              <p className="muted" style={{ margin: 0 }}>
                Coming soon — choose Slideshow to configure duration, mode, and
                place the selection on the timeline.
              </p>
            </div>
          </section>
        ) : null}

        {showSlideshowConfig && draft ? (
          <section className="add-asset-generate-section">
            <h3>Slideshow</h3>
            <p className="muted add-asset-generate-note">
              Configure the slideshow, then place or drag it onto the timeline.
              Hit Render after it is placed.
            </p>
            <StagingFields
              draft={draft}
              sourceDurationSec={sourceDurationSec}
              onDraftChange={onDraftChange}
              bakeInfo={bakeInfo}
            />
          </section>
        ) : null}
      </div>

      {canPlace && draft ? (
        <div className="add-asset-generate-footer preview-intent-footer">
          <ClipPlaceHandle draft={draft} />
          <ClipDragHandle draft={draft} />
        </div>
      ) : null}
    </div>
  );
}
