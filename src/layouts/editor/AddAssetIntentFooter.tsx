import type { ReactNode } from "react";
import type { TimelinePlacementState } from "./addAssetTimelinePlacement";
import { ClipDragHandle, ClipPlaceHandle } from "./PreviewStaging";

export function GenerateTargetButton({
  action = "Generate",
  target = "Assets",
  running = false,
  disabled,
  unavailableTitle,
  onClick,
}: {
  action?: string;
  target?: string;
  running?: boolean;
  disabled?: boolean;
  unavailableTitle?: string;
  onClick?: () => void;
}) {
  const unavailable = Boolean(disabled && unavailableTitle);
  return (
    <button
      type="button"
      className={`editor-cartridge-grip is-action editor-add-asset-generate${unavailable ? " is-soon" : ""}`}
      disabled={disabled}
      title={unavailable ? unavailableTitle : undefined}
      onClick={onClick}
    >
      {running ? (
        <span className="editor-cartridge-grip-label">Generating…</span>
      ) : (
        <>
          <span className="editor-cartridge-grip-label">{action}</span>
          <span className="editor-cartridge-lane">{target}</span>
        </>
      )}
    </button>
  );
}

export function AssetsGenerateButton({
  disabled,
  unavailableTitle,
  running,
  onClick,
}: {
  disabled?: boolean;
  unavailableTitle?: string;
  running?: boolean;
  onClick?: () => void;
}) {
  return (
    <GenerateTargetButton
      target="Assets"
      disabled={disabled}
      unavailableTitle={unavailableTitle}
      running={running}
      onClick={onClick}
    />
  );
}

export function CloneButton({
  disabled,
  unavailableTitle,
  onClick,
}: {
  disabled?: boolean;
  unavailableTitle?: string;
  onClick?: () => void;
}) {
  const unavailable = Boolean(disabled && unavailableTitle);
  return (
    <button
      type="button"
      className={`editor-cartridge-grip is-action editor-add-asset-generate${unavailable ? " is-soon" : ""}`}
      disabled={disabled}
      title={unavailable ? unavailableTitle : undefined}
      onClick={onClick}
    >
      <span className="editor-cartridge-grip-label">Clone</span>
    </button>
  );
}

export function TryAgainButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="editor-cartridge-grip is-action editor-add-asset-generate"
      onClick={onClick}
    >
      <span className="editor-cartridge-grip-label">Try again</span>
    </button>
  );
}

export function DiscardButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="editor-cartridge-grip is-action editor-add-asset-generate"
      onClick={onClick}
    >
      <span className="editor-cartridge-grip-label">Discard</span>
    </button>
  );
}

export function AddAssetIntentFooter({
  generate,
  clone,
  timeline,
  retry,
  discard,
}: {
  generate?: ReactNode;
  clone?: ReactNode;
  timeline: TimelinePlacementState;
  retry?: ReactNode;
  discard?: ReactNode;
}) {
  const showTimeline = timeline.mode !== "hidden";
  if (!generate && !clone && !showTimeline && !retry && !discard) return null;

  return (
    <div className="add-asset-generate-footer preview-intent-footer">
      {retry}
      {discard}
      {generate}
      {clone}
      {timeline.mode === "active" ? (
        <>
          <ClipPlaceHandle draft={timeline.draft} />
          <ClipDragHandle draft={timeline.draft} />
        </>
      ) : timeline.mode === "disabled" ? (
        <>
          <ClipPlaceHandle
            draft={timeline.draft}
            disabled
            unavailableTitle={timeline.title}
          />
          <ClipDragHandle
            draft={timeline.draft}
            disabled
            unavailableTitle={timeline.title}
          />
        </>
      ) : null}
    </div>
  );
}
