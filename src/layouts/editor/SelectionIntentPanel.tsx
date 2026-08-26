import { useMemo } from "react";
import { requestOpenSettings } from "../../settings/events";
import type { BakeInfo } from "../../library/slideshowMedia";
import {
  GENERATE_INTENTS,
  GENERATE_SERVERS,
  SELECTION_INTENT_MODES,
  addAssetIntentAllowsLibraryGeneration,
  addAssetIntentAllowsTimelinePlacement,
  findSelectionIntentMode,
  intentOffersTimelineDestination,
  intentServerCapability,
  intentTimelinePlacementComingSoon,
  isIntentServerWired,
  makeAddAssetIntent,
  resolveAddAssetIntent,
  selectionModeAllowsTimelinePlacement,
  serversForIntent,
  type AddAssetIntent,
  type GenerateIntentId,
  type GenerateServerId,
  type SelectionIntentModeId,
} from "./previewIntent";
import { StagingFields } from "./PreviewStaging";
import { addAssetDragDraftFromIntent, type StagedClipDraft } from "./stagedClip";
import {
  AddAssetIntentFooter,
} from "./AddAssetIntentFooter";
import {
  type TimelinePlacementState,
} from "./addAssetTimelinePlacement";

import {
  CompositePlatePanel,
  type CompositePlatePanelProps,
} from "./CompositePlatePanel";
import { TextToImageFormLayout } from "./TextToImageForm";
import { GenerateIntentIcon } from "./GenerateIntentIcon";
import { GenerateSystemChooser } from "./GenerateSystemChooser";
import { saveLastGenerateIntent } from "./generateIntentPrefs";
import {
  firstVisibleGenerateServer,
  libraryServerFormReady,
  serverNeedsCredentials,
  useGenerateServerCredentials,
} from "./generateServerCredentials";

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
  const resolvedGenerate = generateIntent
    ? resolveAddAssetIntent(generateIntent)
    : null;
  const intentId = resolvedGenerate?.intentId ?? null;
  const server = resolvedGenerate?.server ?? null;
  const canPlaceSlideshow =
    modeId === "slideshow" &&
    selectionModeAllowsTimelinePlacement(modeId) &&
    canSlideshow &&
    Boolean(draft);
  const canPlaceGenerate =
    showGenerate &&
    canGenerate &&
    addAssetIntentAllowsTimelinePlacement(resolvedGenerate);
  const canLibraryGenerate =
    showGenerate && addAssetIntentAllowsLibraryGeneration(resolvedGenerate);
  const firstPicked = items.find((item) => item.id === pickedIds[0]);
  const generateDraft = addAssetDragDraftFromIntent(resolvedGenerate, {
    startFrameAssetId: pickedIds[0] ?? null,
    thumbUrl: firstPicked?.thumbUrl ?? null,
  });
  const creds = useGenerateServerCredentials();
  const capability =
    intentId && server ? intentServerCapability(intentId, server) : null;
  const comingSoon = capability?.status === "coming_soon";
  const needsCreds = server ? serverNeedsCredentials(server, creds) : false;
  const libraryFormReady = libraryServerFormReady(capability, creds);



  const timelinePlacement = useMemo((): TimelinePlacementState => {
    if (canPlaceSlideshow && draft) {
      return { mode: "active", draft };
    }
    if (canPlaceGenerate && generateDraft) {
      return { mode: "active", draft: generateDraft };
    }
    if (
      showGenerate &&
      intentId &&
      server &&
      generateDraft &&
      intentOffersTimelineDestination(intentId) &&
      isIntentServerWired(intentId, server) &&
      intentTimelinePlacementComingSoon(intentId)
    ) {
      return { mode: "disabled", draft: generateDraft, title: "Coming soon" };
    }
    return { mode: "hidden" };
  }, [
    canPlaceGenerate,
    canPlaceSlideshow,
    draft,
    generateDraft,
    intentId,
    server,
    showGenerate,
  ]);

  const toggleItem = (id: string) => {
    const next = new Set(pickedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onPickedIdsChange(orderedPick(allIds, next));
  };

  const selectIntent = (next: GenerateIntentId) => {
    const preferred = firstVisibleGenerateServer(next, creds, server);
    const intent = makeAddAssetIntent(next, preferred);
    saveLastGenerateIntent(intent);
    onGenerateIntentChange(intent);
  };

  const selectServer = (next: GenerateServerId) => {
    if (!intentId) return;
    const intent = makeAddAssetIntent(intentId, next);
    saveLastGenerateIntent(intent);
    onGenerateIntentChange(intent);
  };

  const generateStatusNote =
    showGenerate && intentId && server ? (
      comingSoon ? (
        <section className="add-asset-generate-section">
          <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
            Coming soon
            {` on ${
              GENERATE_SERVERS.find((s) => s.id === server)?.label ??
              "this system"
            }`}
            .
          </p>
        </section>
      ) : needsCreds ? (
        <section className="add-asset-generate-section">
          <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
            {server === "blue_direct"
              ? "Add Blue credentials in Settings to use Direct to Blue."
              : "Add a Replicate token and enable at least one model in Settings to use Replicate."}{" "}
            <button
              type="button"
              className="btn ghost"
              onClick={() => requestOpenSettings()}
            >
              Open Settings
            </button>
          </p>
        </section>
      ) : null
    ) : null;

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
                }${!m.wired ? " is-soon" : ""}`}
                aria-pressed={modeId === m.id}
                disabled={disabled}
                onClick={() => onModeChange(m.id)}
              >
                <span className="preview-intent-choice-label">{m.label}</span>
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

      {showComposite && composite ? (
        <CompositePlatePanel {...composite} />
      ) : null}

      {showGenerate ? (
        <>
          <section className="add-asset-generate-section">
            <h3>Intent</h3>
            <div className="preview-intent-choice-grid" role="list">
              {GENERATE_INTENTS.map((item) => {
                const anyWired = serversForIntent(item.id).some(
                  (c) => c.status === "wired",
                );
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="listitem"
                    className={`preview-intent-choice preview-intent-choice--compact${
                      intentId === item.id ? " is-selected" : ""
                    }${!anyWired ? " is-soon" : ""}`}
                    aria-pressed={intentId === item.id}
                    onClick={() => selectIntent(item.id)}
                  >
                    <span className="preview-intent-choice-icon">
                      <GenerateIntentIcon intentId={item.id} />
                    </span>
                    <span className="preview-intent-choice-text">
                      <span className="preview-intent-choice-label">
                        {item.label}
                      </span>
                      <span className="muted preview-intent-choice-desc">
                        {item.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <GenerateSystemChooser
            selectedId={server}
            disabled={!intentId}
            onSelect={selectServer}
          />
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

  if (canLibraryGenerate && intentId === "text_to_image" && libraryFormReady && server) {
    return (
      <TextToImageFormLayout
        server={server}
        idPrefix={`selection-${server}-t2i`}
      >
        {({ fields, generateAction }) => (
          <div
            className="add-asset-generate-pane preview-intent-pane"
            aria-label="Choose what to do with selection"
          >
            <div className="add-asset-generate-body">
              {body}
              {fields}
            </div>
            <AddAssetIntentFooter
              generate={generateAction}
              timeline={timelinePlacement}
            />
          </div>
        )}
      </TextToImageFormLayout>
    );
  }

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      aria-label="Choose what to do with selection"
    >
      <div className="add-asset-generate-body">
        {body}
        {generateStatusNote}
      </div>
      <AddAssetIntentFooter timeline={timelinePlacement} />
    </div>
  );
}
