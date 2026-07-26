import type { MultiSelectionClass } from "./selectionClassify";
import { unsupportedSelectionMessage } from "./selectionClassify";

type UnsupportedSelection = Extract<
  MultiSelectionClass,
  { type: "unsupportedVideos" | "unsupportedMixed" }
>;

type UnsupportedSelectionPanelProps = {
  classification: UnsupportedSelection;
  selectionCount: number;
};

export function UnsupportedSelectionPanel({
  classification,
  selectionCount,
}: UnsupportedSelectionPanelProps) {
  const message = unsupportedSelectionMessage(classification);

  return (
    <div
      className="add-asset-generate-pane preview-intent-pane"
      role="status"
      aria-label={message.title}
    >
      <div className="add-asset-generate-body">
        <header className="preview-intent-header">
          <h2 className="preview-intent-title">
            Nothing to do with this selection
          </h2>
          <p className="muted preview-intent-lede">
            Selection · {selectionCount} items
          </p>
        </header>

        <section className="add-asset-generate-section">
          <div className="add-asset-generate-callout">
            <p className="muted" style={{ margin: 0 }}>
              {message.body}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
