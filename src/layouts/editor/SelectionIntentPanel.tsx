import type { BakeInfo } from "../../library/slideshowMedia";
import {
  ADD_ASSET_PROVIDERS,
  SELECTION_INTENT_MODES,
  addAssetIntentAllowsLibraryGeneration,
  addAssetIntentAllowsTimelinePlacement,
  addAssetMethodsForProvider,
  findAddAssetMethod,
  findSelectionIntentMode,
  selectionModeAllowsTimelinePlacement,
  type AddAssetIntent,
  type AddAssetMethodId,
  type AddAssetProviderId,
  type SelectionIntentModeId,
} from "./previewIntent";
import { ClipDragHandle, ClipPlaceHandle, StagingFields } from "./PreviewStaging";
import { addAssetDragDraftFromIntent, type StagedClipDraft } from "./stagedClip";
import {
  CompositePlatePanel,
  type CompositePlatePanelProps,
} from "./CompositePlatePanel";
import { ReplicateTextToImageFormLayout } from "./ReplicateTextToImageForm";

export type SelectionImageItem = {
  id: string;
  title: string;
  thumbUrl: string | null;
};

type SelectionIntentPanelProps = {
  items: SelectionImageItem[];
  pickedIds: string[];
  onPickedIdsChange: (ids: string[]) => void;
  modeId: SelectionIntentModeId | null;
  onModeChange: (modeId: SelectionIntentModeId) => void;
  generateIntent: AddAssetIntent | null;
  onGenerateIntentChange: (intent: AddAssetIntent) => void;
  /** Present once slideshow mode is chosen and a draft is staged. */
  draft: StagedClipDraft | null;
  sourceDurationSec: number;
  onDraftChange: (draft: StagedClipDraft) => void;
  bakeInfo?: BakeInfo | null;
  /** Plate composite controls when Composite mode is active. */
  composite?: CompositePlatePanelProps | null;
};

function orderedPick(allIds: string[], picked: Set<string>): string[] {
  return allIds.filter((id) => picked.has(id));
}

export function SelectionIntentPanel({
  items,
  pickedIds,
  onPickedIdsChange,
  modeId,
  onModeChange,
  generateIntent,
  onGenerateIntentChange,
  draft,
  sourceDurationSec,
  onDraftChange,
  bakeInfo = null,
  composite = null,
}: SelectionIntentPanelProps) {
  const selected = findSelectionIntentMode(modeId);
  const allIds = items.map((item) => item.id);
  const pickedSet = new Set(pickedIds);
  const pickedCount = pickedIds.length;
  const totalCount = items.length;
  const canSlideshow = pickedCount >= 2;
  const canGenerate = pickedCount >= 1;
  const canComposite = pickedCount >= 2;
  const showSlideshowConfig =
    modeId === "slideshow" && draft?.kind === "slideshow";
  const showGenerate =
    modeId === "generate_from_selection" && selected?.wired === true;
  const showComposite =
    modeId === "composite" && selected?.wired === true && Boolean(composite);
  const provider = generateIntent?.provider ?? null;
  const methodId = generateIntent?.methodId ?? null;
  const methods = provider ? addAssetMethodsForProvider(provider) : [];
  const selectedMethod = findAddAssetMethod(methodId);
  const canPlaceSlideshow =
    modeId === "slideshow" &&
    selectionModeAllowsTimelinePlacement(modeId) &&
    canSlideshow &&
    Boolean(draft);
  const canPlaceGenerate =
    showGenerate &&
    canGenerate &&
    addAssetIntentAllowsTimelinePlacement(generateIntent);
  const canLibraryGenerate =
    showGenerate && addAssetIntentAllowsLibraryGeneration(generateIntent);
  const firstPicked = items.find((item) => item.id === pickedIds[0]);
  const generateDraft = canPlaceGenerate
    ? addAssetDragDraftFromIntent(generateIntent, {
        startFrameAssetId: pickedIds[0] ?? null,
        thumbUrl: firstPicked?.thumbUrl ?? null,
      })
    : null;

  const toggleItem = (id: string) => {
    const next = new Set(pickedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPickedIdsChange(orderedPick(allIds, next));
  };

  const selectProvider = (next: AddAssetProviderId) => {
    const first = addAssetMethodsForProvider(next)[0];
    onGenerateIntentChange({
      provider: next,
      methodId: first?.id ?? "blue_timeline_fill",
    });
  };

  const selectMethod = (next: AddAssetMethodId) => {
    if (!provider) return;
    onGenerateIntentChange({ provider, methodId: next });
  };

  const title =
    pickedCount === totalCount
      ? `Selection · ${totalCount} images`
      : `Selection · ${pickedCount} of ${totalCount} images`;

  const body = (
    <>
      <header className="preview-intent-header">
        <h2 className="preview-intent-title">{title}</h2>
        <p className="muted preview-intent-lede">
          Pick which images to use, then choose a mode before placing on the
          timeline or generating.
        </p>
      </header>

      <section className="add-asset-generate-section">
        <div className="add-asset-start-frame-assets-header">
          <h3 style={{ margin: 0 }}>Images</h3>
          <div className="selection-intent-pick-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={pickedCount === totalCount}
              onClick={() => onPickedIdsChange(allIds)}
            >
              All
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={pickedCount === 0}
              onClick={() => onPickedIdsChange([])}
            >
              None
            </button>
          </div>
        </div>
        <p className="muted add-asset-generate-note">
          Click images to include or exclude them from the next action.
        </p>
        <div
          className="add-asset-start-frame-assets-grid selection-intent-images-grid"
          role="listbox"
          aria-label="Images in selection"
          aria-multiselectable="true"
        >
          {items.map((item) => {
            const selectedItem = pickedSet.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={selectedItem}
                className={
                  selectedItem
                    ? "add-asset-start-frame-asset is-selected"
                    : "add-asset-start-frame-asset"
                }
                title={item.title}
                onClick={() => toggleItem(item.id)}
              >
                {item.thumbUrl ? (
                  <img src={item.thumbUrl} alt="" draggable={false} />
                ) : (
                  <span className="muted">Image</span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="add-asset-generate-section">
        <h3>Mode</h3>
        <div className="preview-intent-choice-grid" role="list">
          {SELECTION_INTENT_MODES.map((m) => {
            const disabled =
              (m.id === "slideshow" && !canSlideshow) ||
              (m.id === "generate_from_selection" && !canGenerate) ||
              (m.id === "composite" && !canComposite);
            return (
              <button
                key={m.id}
                type="button"
                role="listitem"
                className={`preview-intent-choice${
                  modeId === m.id ? " is-selected" : ""
                }`}
                aria-pressed={modeId === m.id}
                disabled={disabled}
                onClick={() => onModeChange(m.id)}
              >
                <span className="preview-intent-choice-label">
                  {m.label}
                  {!m.wired ? (
                    <span className="preview-intent-badge">Soon</span>
                  ) : null}
                </span>
                <span className="muted preview-intent-choice-desc">
                  {m.id === "slideshow" && !canSlideshow
                    ? "Pick at least two images for a slideshow."
                    : m.id === "generate_from_selection" && !canGenerate
                      ? "Pick at least one image to generate from."
                      : m.id === "composite" && !canComposite
                        ? "Pick at least two images for a plate."
                        : m.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {selected && !selected.wired ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              Coming soon — pick Slideshow to place images on the timeline, or
              Generate from selection to use them with Parascene or Replicate.
            </p>
          </div>
        </section>
      ) : null}

      {showComposite && composite ? (
        <CompositePlatePanel {...composite} />
      ) : null}

      {showGenerate ? (
        <>
          <section className="add-asset-generate-section">
            <h3>Provider</h3>
            <div className="preview-intent-choice-grid" role="list">
              {ADD_ASSET_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="listitem"
                  className={`preview-intent-choice${
                    provider === p.id ? " is-selected" : ""
                  }`}
                  aria-pressed={provider === p.id}
                  onClick={() => selectProvider(p.id)}
                >
                  <span className="preview-intent-choice-label">{p.label}</span>
                  <span className="muted preview-intent-choice-desc">
                    {p.description}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {provider ? (
            <section className="add-asset-generate-section">
              <h3>Method</h3>
              <div className="preview-intent-choice-grid" role="list">
                {methods.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="listitem"
                    className={`preview-intent-choice${
                      methodId === m.id ? " is-selected" : ""
                    }`}
                    aria-pressed={methodId === m.id}
                    onClick={() => selectMethod(m.id)}
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
          ) : null}

          {selectedMethod && !selectedMethod.wired && !canLibraryGenerate ? (
            <section className="add-asset-generate-section">
              <div className="add-asset-generate-callout">
                <p className="muted" style={{ margin: 0 }}>
                  Coming soon — pick Timeline video fill under Parascene or
                  Replicate to place a blank clip. The first picked image seeds
                  the start frame.
                </p>
              </div>
            </section>
          ) : null}

          {canPlaceGenerate ? (
            <section className="add-asset-generate-section">
              <div className="add-asset-generate-callout">
                <p className="muted" style={{ margin: 0 }}>
                  Place or drag the clip onto the timeline. The first picked
                  image is used as the start frame; generation options open
                  once it is on the timeline.
                </p>
              </div>
            </section>
          ) : null}
        </>
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
    </>
  );

  if (canLibraryGenerate) {
    return (
      <ReplicateTextToImageFormLayout idPrefix="selection-t2i">
        {({ fields, footer }) => (
          <div
            className="add-asset-generate-pane preview-intent-pane"
            aria-label="Choose what to do with selection"
          >
            <div className="add-asset-generate-body">
              {body}
              {fields}
            </div>
            {footer}
          </div>
        )}
      </ReplicateTextToImageFormLayout>
    );
  }

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      aria-label="Choose what to do with selection"
    >
      <div className="add-asset-generate-body">{body}</div>

      {canPlaceSlideshow && draft ? (
        <div className="add-asset-generate-footer preview-intent-footer">
          <ClipPlaceHandle draft={draft} />
          <ClipDragHandle draft={draft} />
        </div>
      ) : null}

      {canPlaceGenerate && generateDraft ? (
        <div className="add-asset-generate-footer preview-intent-footer">
          <ClipPlaceHandle draft={generateDraft} />
          <ClipDragHandle draft={generateDraft} />
        </div>
      ) : null}
    </div>
  );
}
