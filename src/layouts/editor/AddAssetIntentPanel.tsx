import { useCallback } from "react";
import { requestOpenSettings } from "../../settings/events";
import type {
  AddAssetDraft,
  AddAssetGeneration,
  LyricAlignment,
  ProjectAsset,
  TimelineClip,
} from "../../project/types";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import { isImageToImageGeneration, isTextToImageGeneration } from "../../project/desktopAddAssetGeneration";
import type { AddAssetGenerationSession } from "./addAssetGenerate";
import {
  GENERATE_INTENTS,
  GENERATE_SERVERS,
  addAssetIntentAllowsLibraryGeneration,
  addAssetIntentAllowsTimelinePlacement,
  findGenerateIntent,
  intentOffersAssetsDestination,
  intentOffersTimelineDestination,
  intentServerCapability,
  intentTimelinePlacementComingSoon,
  isIntentServerWired,
  makeAddAssetIntent,
  resolveAddAssetIntent,
  resolveDestination,
  serversForIntent,
  type AddAssetIntent,
  type GenerateIntentId,
  type GenerateServerId,
} from "./previewIntent";
import type { LibraryGenerateUiState } from "./generateDualView";
import { GenerateIntentIcon } from "./GenerateIntentIcon";
import { GenerateSystemChooser } from "./GenerateSystemChooser";
import { saveLastGenerateIntent } from "./generateIntentPrefs";
import { addAssetDragDraftFromIntent } from "./stagedClip";
import {
  AddAssetIntentFooter,
  AssetsGenerateButton,
  DiscardButton,
  TryAgainButton,
} from "./AddAssetIntentFooter";
import {
  resolveAddAssetTimelinePlacement,
} from "./addAssetTimelinePlacement";

import { TextToImageFormLayout } from "./TextToImageForm";
import {
  ParasceneImageToImageFormLayout,
} from "./ParasceneImageToImageForm";
import {
  AddAssetGeneratePanel,
  type StartAddAssetGenerationRequest,
} from "./AddAssetGeneratePanel";
import {
  firstVisibleGenerateServer,
  libraryServerFormReady,
  serverNeedsCredentials,
  useGenerateServerCredentials,
} from "./generateServerCredentials";

type AddAssetIntentPanelProps = {
  intent: AddAssetIntent | null;
  onIntentChange: (intent: AddAssetIntent) => void;
  /** Placed timeline placeholder — same shell, generate fields below. */
  placedClip?: TimelineClip | null;
  aspectRatio?: ProjectAspectRatio;
  session?: AddAssetGenerationSession | null;
  timeline?: readonly TimelineClip[];
  lyricAlignment?: LyricAlignment | null;
  mainAudioCreationId?: string | null;
  onStartGeneration?: (request: StartAddAssetGenerationRequest) => void;
  onDurationChange?: (durationSec: number) => void;
  onDraftChange?: (draft: AddAssetDraft) => void;
  onClearError?: () => void;
  onRetryDownload?: () => void;
  imageAssets?: ProjectAsset[];
  videoAssets?: ProjectAsset[];
  audioAssets?: ProjectAsset[];
  /** Lock intent when placed on timeline; lock server only when `locked`. */
  locked?: boolean;
  /** Progress UI lives on Result — keep form visible while generating. */
  progressHostedExternally?: boolean;
  onGenerateNew?: () => void;
  /** Exit + slot once a library placeholder asset is reserved. */
  onLibraryAssetGenerationStarted?: (assetId: string) => void;
  /** Library T2I: report phase so PreviewPane can host Result | Form. */
  onLibraryGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  hideLibraryInlineProgress?: boolean;
  /** Finished generation — seed locked T2I form (Assets Result | Form). */
  reviewGeneration?: AddAssetGeneration | null;
  /** Seed prompt/model when forking Generate new into the + slot. */
  libraryFormSeed?: {
    prompt: string;
    model?: string;
    startFrameAssetId?: string;
  } | null;
  /** Reuse an existing Generate → Assets placeholder instead of reserving a new id. */
  libraryPlaceholderId?: string | null;
  /** Dual-view failure recovery — footer actions while the form stays locked. */
  errorRecovery?: {
    onDiscard?: () => void;
    onRetry?: () => void;
  };
};

export function AddAssetIntentPanel({
  intent,
  onIntentChange,
  placedClip = null,
  aspectRatio,
  session = null,
  timeline = [],
  lyricAlignment = null,
  mainAudioCreationId = null,
  onStartGeneration,
  onDurationChange,
  onDraftChange,
  onClearError,
  onRetryDownload,
  imageAssets = [],
  videoAssets = [],
  audioAssets = [],
  locked = false,
  progressHostedExternally = false,
  onGenerateNew,
  onLibraryAssetGenerationStarted,
  onLibraryGenerateStateChange,
  hideLibraryInlineProgress = false,
  reviewGeneration = null,
  libraryFormSeed = null,
  libraryPlaceholderId = null,
  errorRecovery,
}: AddAssetIntentPanelProps) {
  const placed = Boolean(placedClip);
  const intentLocked = locked || placed;
  const resolved = intent ? resolveAddAssetIntent(intent) : null;
  const intentId = resolved?.intentId ?? null;
  const server = resolved?.server ?? null;
  const destination = resolveDestination(resolved);
  const selectedIntent = findGenerateIntent(intentId);
  const capability =
    intentId && server ? intentServerCapability(intentId, server) : null;
  const canPlace =
    !placed && addAssetIntentAllowsTimelinePlacement(resolved);
  const timelineSoon =
    !placed &&
    Boolean(intentId) &&
    intentOffersTimelineDestination(intentId) &&
    intentTimelinePlacementComingSoon(intentId) &&
    Boolean(server) &&
    isIntentServerWired(intentId!, server!);
  const canLibraryGenerate =
    !placed && addAssetIntentAllowsLibraryGeneration(resolved);
  const reviewT2i =
    locked &&
    !placed &&
    isTextToImageGeneration(reviewGeneration) &&
    intentId === "text_to_image" &&
    (server === "blue_direct" ||
      server === "replicate" ||
      server === "parascene_blue");
  const reviewI2i =
    locked &&
    !placed &&
    isImageToImageGeneration(reviewGeneration) &&
    intentId === "image_to_image" &&
    server === "parascene_blue";
  const showLibraryT2i =
    (canLibraryGenerate || reviewT2i) &&
    intentId === "text_to_image" &&
    (server === "blue_direct" ||
      server === "replicate" ||
      server === "parascene_blue");
  const showLibraryI2i =
    (canLibraryGenerate || reviewI2i) &&
    intentId === "image_to_image" &&
    server === "parascene_blue";
  const t2iPrompt = reviewGeneration?.prompt ?? libraryFormSeed?.prompt ?? "";
  const t2iModelId =
    reviewGeneration?.model?.trim() ||
    libraryFormSeed?.model?.trim() ||
    undefined;
  const i2iSourceAssetId =
    reviewGeneration?.startFrameAssetId?.trim() ||
    libraryFormSeed?.startFrameAssetId?.trim() ||
    undefined;
  const comingSoon = capability?.status === "coming_soon";
  const offersAssets =
    !placed && Boolean(intentId) && intentOffersAssetsDestination(intentId);
  const assetsSoon =
    offersAssets &&
    !canLibraryGenerate &&
    !comingSoon &&
    Boolean(intentId && server && isIntentServerWired(intentId, server));
  const dragDraft = addAssetDragDraftFromIntent(resolved);
  const creds = useGenerateServerCredentials();

  const serverNeedsCreds = (id: GenerateServerId): boolean =>
    serverNeedsCredentials(id, creds);

  const firstSelectableServer = (
    intent: GenerateIntentId,
    prefer?: GenerateServerId | null,
  ): GenerateServerId => firstVisibleGenerateServer(intent, creds, prefer);

  const libraryFormReady = libraryServerFormReady(capability, creds);

  const commitIntent = useCallback(
    (next: AddAssetIntent) => {
      saveLastGenerateIntent(next);
      onIntentChange(next);
    },
    [onIntentChange],
  );

  const selectIntent = (next: GenerateIntentId) => {
    if (intentLocked) return;
    commitIntent(makeAddAssetIntent(next, firstSelectableServer(next, server)));
  };

  const selectServer = (next: GenerateServerId) => {
    if (locked || !intentId) return;
    commitIntent(
      makeAddAssetIntent(
        intentId,
        next,
        placed ? "timeline" : destination,
      ),
    );
  };

  const needsCreds = server ? serverNeedsCreds(server) : false;

  const libraryStatusNote =
    !placed && intentId && server ? (
      comingSoon ? (
        <section className="add-asset-generate-section">
          <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
            Coming soon
            {selectedIntent ? ` — ${selectedIntent.label}` : ""}
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

  const timelinePlacement = resolveAddAssetTimelinePlacement({
    placed,
    intentId,
    server,
    draft: dragDraft,
    comingSoon,
    needsCreds,
    canPlace,
    timelineSoon,
  });

  const assetsSoonGenerateAction =
    !placed && assetsSoon && !comingSoon && !needsCreds ? (
      <AssetsGenerateButton disabled unavailableTitle="Coming soon" />
    ) : null;

  const intentFooter = (parts?: {
    generate?: React.ReactNode;
    clone?: React.ReactNode;
  }) => {
    const recoveryActive = Boolean(
      locked &&
        errorRecovery &&
        (errorRecovery.onDiscard || errorRecovery.onRetry),
    );
    return (
      <AddAssetIntentFooter
        retry={
          recoveryActive && errorRecovery?.onRetry ? (
            <TryAgainButton onClick={errorRecovery.onRetry} />
          ) : undefined
        }
        discard={
          recoveryActive && errorRecovery?.onDiscard ? (
            <DiscardButton onClick={errorRecovery.onDiscard} />
          ) : undefined
        }
        generate={
          recoveryActive
            ? undefined
            : locked
              ? undefined
              : (parts?.generate ?? assetsSoonGenerateAction ?? undefined)
        }
        clone={recoveryActive ? undefined : parts?.clone}
        timeline={locked || placed ? { mode: "hidden" } : timelinePlacement}
      />
    );
  };

  const choices = (
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
                disabled={intentLocked}
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
        disabled={locked || !intentId}
        onSelect={selectServer}
      />

      {!placed &&
      selectedIntent?.destinationPolicy === "timeline_only" ? (
        <p className="muted add-asset-generate-note">
          This intent uses timeline audio or neighbors — place on the timeline
          to generate.
        </p>
      ) : null}
    </>
  );

  const placedForm =
    placed &&
    placedClip &&
    aspectRatio &&
    onStartGeneration &&
    !comingSoon &&
    !needsCreds ? (
      <AddAssetGeneratePanel
        key={locked ? "locked-review-generate" : placedClip.id}
        embedded
        clip={placedClip}
        aspectRatio={aspectRatio}
        timeline={timeline}
        lyricAlignment={lyricAlignment}
        mainAudioCreationId={mainAudioCreationId}
        session={session}
        onStartGeneration={onStartGeneration}
        onDurationChange={onDurationChange}
        onDraftChange={onDraftChange}
        onClearError={onClearError}
        onRetryDownload={onRetryDownload}
        imageAssets={imageAssets}
        videoAssets={videoAssets}
        audioAssets={audioAssets}
        progressHostedExternally={progressHostedExternally}
        formLocked={locked}
        errorRecovery={errorRecovery}
        onGenerateNew={onGenerateNew}
      />
    ) : placed && comingSoon ? (
      <section className="add-asset-generate-section">
        <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
          Coming soon
          {selectedIntent ? ` — ${selectedIntent.label}` : ""}
          {server
            ? ` on ${
                GENERATE_SERVERS.find((s) => s.id === server)?.label ??
                "this system"
              }`
            : ""}
          .
        </p>
      </section>
    ) : placed && needsCreds && server ? (
      <section className="add-asset-generate-section">
        <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
          {server === "blue_direct"
            ? "Add Blue credentials in Settings to use Direct to Blue."
            : "Add a Replicate token in Settings to use Replicate."}{" "}
          <button
            type="button"
            className="btn ghost"
            onClick={() => requestOpenSettings()}
          >
            Open Settings
          </button>
        </p>
      </section>
    ) : null;

  if (showLibraryT2i && libraryFormReady && server) {
    return (
      <TextToImageFormLayout
        server={server}
        idPrefix={`add-asset-${server}-t2i`}
        locked={locked}
        onGenerateNew={onGenerateNew}
        placeholderId={libraryPlaceholderId ?? undefined}
        initialPrompt={t2iPrompt}
        initialModelId={t2iModelId}
      >
        {({ fields, generateAction, cloneAction }) => (
          <div
            className="add-asset-generate-pane preview-intent-pane"
            aria-label="Choose generation method"
          >
            <div className="add-asset-generate-body">
              {choices}
              {fields}
            </div>
            {intentFooter({ generate: generateAction, clone: cloneAction })}
          </div>
        )}
      </TextToImageFormLayout>
    );
  }

  if (showLibraryI2i && libraryFormReady) {
    return (
      <ParasceneImageToImageFormLayout
        locked={locked}
        hideInlineProgress={hideLibraryInlineProgress}
        imageAssets={imageAssets}
        onGenerateStateChange={onLibraryGenerateStateChange}
        onGenerateNew={onGenerateNew}
        onLibraryAssetGenerationStarted={onLibraryAssetGenerationStarted}
        placeholderId={libraryPlaceholderId ?? undefined}
        initialPrompt={libraryFormSeed?.prompt ?? reviewGeneration?.prompt ?? ""}
        initialModelId={libraryFormSeed?.model ?? reviewGeneration?.model}
        initialSourceAssetId={i2iSourceAssetId}
        reviewGeneration={reviewGeneration}
      >
        {({ fields, generateAction, cloneAction }) => (
          <div
            className="add-asset-generate-pane preview-intent-pane"
            aria-label="Choose generation method"
          >
            <div className="add-asset-generate-body">
              {choices}
              {fields}
            </div>
            {intentFooter({ generate: generateAction, clone: cloneAction })}
          </div>
        )}
      </ParasceneImageToImageFormLayout>
    );
  }

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      aria-label="Choose generation method"
    >
      <div className="add-asset-generate-body">
        {choices}
        {libraryStatusNote}
        {placedForm}
      </div>
      {!placed ? intentFooter() : null}
    </div>
  );
}
