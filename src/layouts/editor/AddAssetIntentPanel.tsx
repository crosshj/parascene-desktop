import { useEffect, useState } from "react";
import { blueCredentialsStatus } from "../../blue/blueClient";
import {
  BLUE_CREDENTIALS_CHANGED_EVENT,
  REPLICATE_TOKEN_CHANGED_EVENT,
  requestOpenSettings,
} from "../../settings/events";
import { replicateTokenStatus } from "../../replicate/replicateClient";
import type {
  AddAssetDraft,
  AddAssetGeneration,
  LyricAlignment,
  ProjectAsset,
  TimelineClip,
} from "../../project/types";
import type { ProjectAspectRatio } from "../../project/aspectRatios";
import { isTextToImageGeneration } from "../../project/desktopAddAssetGeneration";
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
import { GenerateServerIcon } from "./GenerateServerIcon";
import { saveLastGenerateIntent } from "./generateIntentPrefs";
import { addAssetDragDraftFromIntent } from "./stagedClip";
import { ClipDragHandle, ClipPlaceHandle } from "./PreviewStaging";
import { ReplicateTextToImageFormLayout } from "./ReplicateTextToImageForm";
import { BlueDirectTextToImageForm } from "./BlueDirectTextToImageForm";
import {
  AddAssetGeneratePanel,
  type StartAddAssetGenerationRequest,
} from "./AddAssetGeneratePanel";

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
  /** Lock intent/server choices (and nested generate fields when placed). */
  locked?: boolean;
  /** Progress UI lives on Result — keep form visible while generating. */
  progressHostedExternally?: boolean;
  onGenerateNew?: () => void;
  /** Library T2I: report phase so PreviewPane can host Result | Form. */
  onLibraryGenerateStateChange?: (state: LibraryGenerateUiState) => void;
  hideLibraryInlineProgress?: boolean;
  /** Finished generation — seed locked T2I form (Assets Result | Form). */
  reviewGeneration?: AddAssetGeneration | null;
  /** Seed prompt/model when forking Generate new into the + slot. */
  libraryFormSeed?: { prompt: string; model?: string } | null;
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
  locked = false,
  progressHostedExternally = false,
  onGenerateNew,
  onLibraryGenerateStateChange,
  hideLibraryInlineProgress = false,
  reviewGeneration = null,
  libraryFormSeed = null,
}: AddAssetIntentPanelProps) {
  const placed = Boolean(placedClip);
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
    (server === "blue_direct" || server === "replicate");
  const showLibraryT2i =
    (canLibraryGenerate || reviewT2i) &&
    intentId === "text_to_image" &&
    (server === "blue_direct" || server === "replicate");
  const t2iPrompt = reviewGeneration?.prompt ?? libraryFormSeed?.prompt ?? "";
  const t2iModelId =
    reviewGeneration?.model?.trim() ||
    libraryFormSeed?.model?.trim() ||
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

  const [blueConfigured, setBlueConfigured] = useState<boolean | null>(null);
  const [replicateConfigured, setReplicateConfigured] = useState<
    boolean | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void blueCredentialsStatus()
        .then((s) => {
          if (!cancelled) setBlueConfigured(s.configured);
        })
        .catch(() => {
          if (!cancelled) setBlueConfigured(false);
        });
      void replicateTokenStatus()
        .then((s) => {
          if (!cancelled) setReplicateConfigured(s.configured);
        })
        .catch(() => {
          if (!cancelled) setReplicateConfigured(false);
        });
    };
    refresh();
    window.addEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
    window.addEventListener(REPLICATE_TOKEN_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
      window.removeEventListener(REPLICATE_TOKEN_CHANGED_EVENT, refresh);
    };
  }, []);

  const serverNeedsCreds = (id: GenerateServerId): boolean => {
    if (id === "blue_direct") return blueConfigured === false;
    if (id === "replicate") return replicateConfigured === false;
    return false;
  };

  const commitIntent = (next: AddAssetIntent) => {
    saveLastGenerateIntent(next);
    onIntentChange(next);
  };

  const selectIntent = (next: GenerateIntentId) => {
    if (locked) return;
    const caps = serversForIntent(next);
    const preferred =
      (server && caps.find((c) => c.server === server)?.server) ||
      caps.find((c) => c.status === "wired")?.server ||
      caps[0]?.server ||
      "parascene_blue";
    commitIntent(makeAddAssetIntent(next, preferred));
  };

  const selectServer = (next: GenerateServerId) => {
    if (locked || !intentId) return;
    // Placed clips are timeline; otherwise keep last destination preference.
    commitIntent(
      makeAddAssetIntent(
        intentId,
        next,
        placed ? "timeline" : destination,
      ),
    );
  };

  const needsCreds = server ? serverNeedsCreds(server) : false;

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
                disabled={locked}
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

      {intentId ? (
        <section className="add-asset-generate-section">
          <h3>Server</h3>
          <div className="preview-intent-choice-grid" role="list">
            {serversForIntent(intentId).map((cap) => {
              const def = GENERATE_SERVERS.find((s) => s.id === cap.server);
              if (!def) return null;
              const needs = serverNeedsCreds(cap.server);
              const soon = cap.status === "coming_soon";
              return (
                <button
                  key={cap.server}
                  type="button"
                  role="listitem"
                  className={`preview-intent-choice preview-intent-choice--compact${
                    server === cap.server ? " is-selected" : ""
                  }${soon ? " is-soon" : ""}`}
                  aria-pressed={server === cap.server}
                  disabled={locked}
                  onClick={() => selectServer(cap.server)}
                >
                  <span className="preview-intent-choice-icon preview-intent-choice-icon--brand">
                    <GenerateServerIcon serverId={cap.server} />
                  </span>
                  <span className="preview-intent-choice-text">
                    <span className="preview-intent-choice-label">
                      {def.label}
                    </span>
                    <span className="muted preview-intent-choice-desc">
                      {needs
                        ? "Needs Settings credentials"
                        : def.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {!placed &&
      selectedIntent?.destinationPolicy === "timeline_only" ? (
        <p className="muted add-asset-generate-note">
          This intent uses timeline audio or neighbors — place on the timeline
          to generate.
        </p>
      ) : null}
    </>
  );

  const statusCallouts = (
    <>
      {!placed && comingSoon ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              Coming soon
              {selectedIntent ? ` — ${selectedIntent.label}` : ""}
              {server
                ? ` on ${
                    GENERATE_SERVERS.find((s) => s.id === server)?.label ??
                    "this server"
                  }`
                : ""}
              . Pick a ready path to generate today.
            </p>
          </div>
        </section>
      ) : null}

      {!placed && needsCreds && server ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
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
          </div>
        </section>
      ) : null}

      {assetsSoon && !comingSoon && !needsCreds ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              Generate to Assets for this intent is coming soon
              {canPlace || timelineSoon
                ? " — use Place or Drag for the timeline"
                : ""}
              {selectedIntent?.id === "image_to_video"
                ? " (or seed a start frame from a project still after placing)."
                : "."}
            </p>
          </div>
        </section>
      ) : null}

      {timelineSoon && !comingSoon && !needsCreds ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              Place on timeline is coming soon for stills. Generate into Assets
              for now, then add the image to the timeline later.
            </p>
          </div>
        </section>
      ) : null}

      {canPlace && !comingSoon && !needsCreds ? (
        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              Place or drag onto the timeline to continue generating.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );

  const timelineFooter =
    canPlace && !comingSoon && !needsCreds ? (
      <div className="add-asset-generate-footer preview-intent-footer">
        <ClipPlaceHandle draft={dragDraft} />
        <ClipDragHandle draft={dragDraft} />
      </div>
    ) : timelineSoon && !comingSoon && !needsCreds ? (
      <div className="add-asset-generate-footer preview-intent-footer">
        <button
          type="button"
          className="editor-cartridge-grip is-soon"
          disabled
          title="Place on timeline coming soon for stills"
        >
          <span className="editor-cartridge-grip-label">
            Place · Soon
          </span>
        </button>
      </div>
    ) : null;

  const placedForm =
    placed &&
    placedClip &&
    aspectRatio &&
    onStartGeneration &&
    !comingSoon &&
    !needsCreds ? (
      <AddAssetGeneratePanel
        key={placedClip.id}
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
        progressHostedExternally={progressHostedExternally}
        formLocked={locked}
        onGenerateNew={onGenerateNew}
      />
    ) : placed && comingSoon ? (
      <section className="add-asset-generate-section">
        <div className="add-asset-generate-callout">
          <p className="muted" style={{ margin: 0 }}>
            Coming soon
            {selectedIntent ? ` — ${selectedIntent.label}` : ""}
            {server
              ? ` on ${
                  GENERATE_SERVERS.find((s) => s.id === server)?.label ??
                  "this server"
                }`
              : ""}
            . Pick a ready path to generate on this clip.
          </p>
        </div>
      </section>
    ) : placed && needsCreds && server ? (
      <section className="add-asset-generate-section">
        <div className="add-asset-generate-callout">
          <p className="muted" style={{ margin: 0 }}>
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
        </div>
      </section>
    ) : null;

  if (
    showLibraryT2i &&
    server === "replicate"
  ) {
    return (
      <ReplicateTextToImageFormLayout
        idPrefix="add-asset-t2i"
        locked={locked}
        hideInlineProgress={hideLibraryInlineProgress}
        onGenerateStateChange={onLibraryGenerateStateChange}
        onGenerateNew={onGenerateNew}
        initialPrompt={t2iPrompt}
        initialModelId={t2iModelId}
      >
        {({ fields, footer }) => (
          <div
            className="add-asset-generate-pane preview-intent-pane"
            aria-label="Choose generation method"
          >
            <div className="add-asset-generate-body">
              {choices}
              {fields}
              {!locked ? statusCallouts : null}
            </div>
            {footer}
            {!locked ? timelineFooter : null}
          </div>
        )}
      </ReplicateTextToImageFormLayout>
    );
  }

  if (
    showLibraryT2i &&
    server === "blue_direct"
  ) {
    return (
      <div
        className="add-asset-generate-pane preview-intent-pane"
        aria-label="Choose generation method"
      >
        <div className="add-asset-generate-body">
          {choices}
          <BlueDirectTextToImageForm
            locked={locked}
            hideInlineProgress={hideLibraryInlineProgress}
            onGenerateStateChange={onLibraryGenerateStateChange}
            onGenerateNew={onGenerateNew}
            initialPrompt={t2iPrompt}
            initialModelId={t2iModelId}
          />
          {!locked ? statusCallouts : null}
        </div>
        {!locked ? timelineFooter : null}
      </div>
    );
  }

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      aria-label="Choose generation method"
    >
      <div className="add-asset-generate-body">
        {choices}
        {placedForm}
        {!placed ? statusCallouts : null}
      </div>
      {!placed ? timelineFooter : null}
    </div>
  );
}
