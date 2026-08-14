/**
 * Plate composite controls — slots, layout, live preview commit.
 */

import { useMemo, useState } from "react";
import type { StillWorkstream } from "../../project/stillWorkstream";
import type { PlateRecipe } from "../../project/stillWorkstream";

export type CompositePlatePanelProps = {
  pickedIds: string[];
  onPickedIdsChange: (ids: string[]) => void;
  /** Live layout preview URL (convertFileSrc of cache bake). */
  previewUrl: string | null;
  /** Live composer recipe preview, even when a saved run is selected. */
  platePreviewUrl: string | null;
  canCreate: boolean;
  recipe: PlateRecipe;
  onRecipeChange: (recipe: PlateRecipe) => void;
  activeWorkstream: StillWorkstream | null;
  busy: boolean;
  previewBusy: boolean;
  statusNote: string | null;
  errorNote: string | null;
  autoGapPx: number | null;
  editPrompt: string;
  onEditPromptChange: (prompt: string) => void;
  editModel: string;
  onEditModelChange: (model: string) => void;
  enabledModels: readonly string[];
  onCreateComposition: () => void;
  onExportNode: (nodeId: string) => void;
  onEdit: () => void;
  onSelectNode: (nodeId: string) => void;
  onSelectPlate: () => void;
  onDeleteNode: (nodeId: string) => void;
  nodePreviewUrls: Readonly<Record<string, string>>;
  onCloseComposition?: () => void;
  /** Source image ids used by this plate that are not in the project folder. */
  outsideSourceIds?: readonly string[];
  /** Preview URLs for plate source ids. */
  sourcePreviewUrls?: Readonly<Record<string, string | null>>;
  /** File an outside source into the open project folder. */
  onAddSourceToProject?: (creationId: string) => void;
};

const ASPECTS = ["1:1", "16:9", "9:16", "4:5", "4:3"] as const;
const RESOLUTIONS = [1024, 1536, 2048, 3072] as const;

function sourceSlotLabel(index: number, total: number): string {
  if (total === 2) return index === 0 ? "Left" : "Right";
  return `Source ${index + 1}`;
}

export function CompositePlatePanel({
  pickedIds,
  onPickedIdsChange,
  previewUrl,
  platePreviewUrl,
  canCreate,
  recipe,
  onRecipeChange,
  activeWorkstream,
  busy,
  previewBusy,
  statusNote,
  errorNote,
  autoGapPx,
  editPrompt,
  onEditPromptChange,
  editModel,
  onEditModelChange,
  enabledModels,
  onCreateComposition,
  onExportNode,
  onEdit,
  onSelectNode,
  onSelectPlate,
  onDeleteNode,
  nodePreviewUrls,
  onCloseComposition,
  outsideSourceIds = [],
  sourcePreviewUrls = {},
  onAddSourceToProject,
}: CompositePlatePanelProps) {
  const [showHistory, setShowHistory] = useState(true);
  const liveNodes =
    activeWorkstream?.nodes.filter((n) => n.status !== "discarded") ?? [];
  const outsideSet = useMemo(
    () => new Set(outsideSourceIds.map((id) => id.trim()).filter(Boolean)),
    [outsideSourceIds],
  );

  const swapLeftRight = () => {
    if (pickedIds.length < 2) return;
    const next = [...pickedIds];
    const a = next[0];
    next[0] = next[1]!;
    next[1] = a!;
    onPickedIdsChange(next);
  };

  return (
    <>
      {activeWorkstream ? (
        <header className="composite-open-header">
          <div>
            <h2 className="preview-intent-title" style={{ margin: 0 }}>
              {activeWorkstream.title}
            </h2>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              Composition sandbox — layout and AI edits stay here until you add
              one to Assets.
            </p>
          </div>
          {onCloseComposition ? (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={onCloseComposition}
            >
              Close
            </button>
          ) : null}
        </header>
      ) : null}

      {pickedIds.length > 0 ? (
        <section className="add-asset-generate-section composite-sources-section">
          <h3>Sources</h3>
          <ul className="composite-source-row">
            {pickedIds.map((id, index) => {
              const outside = outsideSet.has(id);
              const thumb = sourcePreviewUrls[id] ?? null;
              return (
                <li key={`${id}:${index}`}>
                  <article
                    className={`composite-source-card${outside ? " is-outside" : ""}`}
                  >
                    <div className="composite-source-thumb">
                      {thumb ? (
                        <img src={thumb} alt="" draggable={false} />
                      ) : (
                        <span className="muted">No preview</span>
                      )}
                      {outside ? (
                        <span className="composition-outside-flag">Outside</span>
                      ) : null}
                    </div>
                    <div className="composite-source-meta">
                      <strong>{sourceSlotLabel(index, pickedIds.length)}</strong>
                      {outside && onAddSourceToProject ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={() => onAddSourceToProject(id)}
                        >
                          Add to this project
                        </button>
                      ) : null}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="composite-recipe-preview-layout">
      <section className="add-asset-generate-section composite-preview-section">
          <div className="composite-preview-heading">
            <h3>Plate preview</h3>
            <button
              type="button"
              className="btn"
              disabled={busy || pickedIds.length < 2}
              onClick={swapLeftRight}
              title="Swap the left and right source images"
            >
              Swap order
            </button>
          </div>
          <div className="composite-live-preview">
            {previewUrl ? (
              <img
                key={previewUrl}
                src={previewUrl}
                alt="Plate layout preview"
                className="composite-live-preview-img"
                draggable={false}
              />
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                {pickedIds.length < 2
                  ? "Pick at least two images to preview the plate."
                  : previewBusy
                    ? "Building preview…"
                    : "Preview will appear here."}
              </p>
            )}
          </div>
          {previewBusy && previewUrl ? (
            <p className="muted" style={{ margin: "0.35rem 0 0" }}>
              Updating preview…
            </p>
          ) : null}
      </section>

      <section className="add-asset-generate-section composite-recipe-section">
        <h3>Plate recipe</h3>
        <p className="muted" style={{ margin: "0 0 0.5rem" }}>
          {activeWorkstream
            ? "Changes update the composer plate immediately and are saved with this composition."
            : "Create a composition in Assets to keep this recipe, then iterate plate and AI edits inside it."}
        </p>
        <label className="add-asset-generate-field">
          <span>Placement</span>
          <select
            value={recipe.placement}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                placement: event.target.value as PlateRecipe["placement"],
                gapMode:
                  event.target.value === "height_fill" ? "auto" : recipe.gapMode,
              })
            }
          >
            <option value="height_fill">
              Fill height (keep aspect)
            </option>
            <option value="equal_columns">Equal columns</option>
          </select>
        </label>
        <label className="add-asset-generate-field">
          <span>Aspect</span>
          <select
            value={recipe.aspectRatio}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({ ...recipe, aspectRatio: event.target.value })
            }
          >
            {ASPECTS.map((aspect) => (
              <option key={aspect} value={aspect}>
                {aspect}
              </option>
            ))}
          </select>
        </label>
        <label className="add-asset-generate-field">
          <span>Resolution (long edge)</span>
          <select
            value={String(recipe.resolution)}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                resolution: Number(event.target.value) || 2048,
              })
            }
          >
            {RESOLUTIONS.map((res) => (
              <option key={res} value={res}>
                {res}px
              </option>
            ))}
          </select>
        </label>
        {recipe.placement === "equal_columns" ? (
          <label className="add-asset-generate-field">
            <span>Framing</span>
            <select
              value={recipe.framing}
              disabled={busy}
              onChange={(event) =>
                onRecipeChange({
                  ...recipe,
                  framing: event.target.value as PlateRecipe["framing"],
                })
              }
            >
              <option value="fit">Fit</option>
              <option value="fill">Fill</option>
              <option value="stretch">Stretch</option>
            </select>
          </label>
        ) : null}
        <label className="add-asset-generate-field">
          <span>Gap</span>
          <select
            value={recipe.gapMode}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                gapMode: event.target.value as PlateRecipe["gapMode"],
              })
            }
          >
            <option value="auto">
              Automatic
              {autoGapPx != null ? ` (${autoGapPx}px)` : ""}
            </option>
            <option value="fixed">Fixed</option>
          </select>
        </label>
        {recipe.gapMode === "fixed" ? (
          <label className="add-asset-generate-field">
            <span>Gap (px)</span>
            <input
              type="number"
              min={0}
              max={512}
              value={recipe.gapPx}
              disabled={busy}
              onChange={(event) =>
                onRecipeChange({
                  ...recipe,
                  gapPx: Math.max(0, Number(event.target.value) || 0),
                })
              }
            />
          </label>
        ) : null}
        <label className="add-asset-generate-field">
          <span>Margin (px)</span>
          <input
            type="number"
            min={0}
            max={512}
            value={recipe.marginPx}
            disabled={busy}
            onChange={(event) =>
              onRecipeChange({
                ...recipe,
                marginPx: Math.max(0, Number(event.target.value) || 0),
              })
            }
          />
        </label>
        {!activeWorkstream ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCreate || busy}
            onClick={onCreateComposition}
          >
            {busy ? "Creating…" : "Create composition"}
          </button>
        ) : null}
      </section>
      </div>

      {activeWorkstream ? (
        <section className="add-asset-generate-section">
          <h3>Runs</h3>
          <p className="muted" style={{ margin: "0 0 0.5rem" }}>
            Choose the composer plate or any previous run as the base for your
            next edit.
          </p>
          <div className="composition-runs">
            <button
              type="button"
              className="linkish"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? "Hide" : "Show"} runs ({liveNodes.length})
            </button>
            {showHistory ? (
              <div className="composition-run-grid">
                <article
                  className={`composition-run-card${
                    activeWorkstream.selectedNodeId === null
                      ? " is-selected"
                      : ""
                  }`}
                  onClick={() => {
                    if (!busy) onSelectPlate();
                  }}
                >
                  <button
                    type="button"
                    className="composition-run-preview"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectPlate();
                    }}
                    aria-label="Use live composer plate as edit base"
                  >
                    {platePreviewUrl ? (
                      <img src={platePreviewUrl} alt="" />
                    ) : (
                      <span className="muted">Building plate preview…</span>
                    )}
                  </button>
                  <div className="composition-run-body">
                    <div className="composition-run-heading">
                      <strong>Composer plate</strong>
                      {activeWorkstream.selectedNodeId === null ? (
                        <span className="composition-run-base">Edit base</span>
                      ) : null}
                    </div>
                    <p>Current sources and plate recipe</p>
                  </div>
                </article>
                {liveNodes.map((node, index) => (
                  <article
                    key={node.id}
                    className={`composition-run-card${
                      node.id === activeWorkstream.selectedNodeId
                        ? " is-selected"
                        : ""
                    }`}
                    onClick={() => {
                      if (!busy) onSelectNode(node.id);
                    }}
                  >
                    <button
                      type="button"
                      className="composition-run-preview"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectNode(node.id);
                      }}
                      aria-label={`Use run ${index + 1} as edit base`}
                    >
                      {nodePreviewUrls[node.id] ? (
                        <img src={nodePreviewUrls[node.id]} alt="" />
                      ) : (
                        <span className="muted">Preview unavailable</span>
                      )}
                    </button>
                    <div className="composition-run-body">
                      <div className="composition-run-heading">
                        <strong>Run {index + 1}</strong>
                        {node.id === activeWorkstream.selectedNodeId ? (
                          <span className="composition-run-base">Edit base</span>
                        ) : null}
                      </div>
                      <p title={node.prompt || "Plate layout"}>
                        {node.prompt || "Plate layout"}
                      </p>
                      <div className="composition-run-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            onExportNode(node.id);
                          }}
                        >
                          Export
                        </button>
                        <button
                          type="button"
                          className="btn composition-run-delete"
                          disabled={busy}
                          title="Delete this internal run permanently"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteNode(node.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </div>

          <div className="composition-create-run">
            <h3>Create another run</h3>
            <p className="muted" style={{ margin: "0 0 0.5rem" }}>
              The highlighted item above will be used as the input.
            </p>
            <label className="add-asset-generate-field">
              <span>Model (owner/name)</span>
              {enabledModels.length > 0 ? (
                <select
                  value={editModel}
                  disabled={busy}
                  onChange={(event) => onEditModelChange(event.target.value)}
                >
                  <option value="">Select enabled model…</option>
                  {enabledModels.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={editModel}
                  disabled={busy}
                  placeholder="owner/model"
                  onChange={(event) => onEditModelChange(event.target.value)}
                />
              )}
            </label>
            <label className="add-asset-generate-field">
              <span>Prompt</span>
              <textarea
                rows={3}
                value={editPrompt}
                disabled={busy}
                placeholder="Fill the gap between subjects; clean seams and bars…"
                onChange={(event) => onEditPromptChange(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                busy ||
                !editModel.trim() ||
                !editPrompt.trim() ||
                (activeWorkstream.selectedNodeId === null && pickedIds.length < 2)
              }
              onClick={onEdit}
            >
              Edit from selected base
            </button>
          </div>
        </section>
      ) : null}

      {statusNote ? (
        <p className="muted" style={{ margin: "0.5rem 0 0" }}>
          {statusNote}
        </p>
      ) : null}
      {errorNote ? (
        <p className="add-asset-generate-error" style={{ margin: "0.5rem 0 0" }}>
          {errorNote}
        </p>
      ) : null}
    </>
  );
}
