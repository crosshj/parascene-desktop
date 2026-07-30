import {
  ADD_ASSET_PROVIDERS,
  addAssetIntentAllowsTimelinePlacement,
  addAssetMethodsForProvider,
  findAddAssetMethod,
  type AddAssetIntent,
  type AddAssetMethodId,
  type AddAssetProviderId,
} from "./previewIntent";
import { addAssetDragDraftFromIntent } from "./stagedClip";
import { ClipDragHandle, ClipPlaceHandle } from "./PreviewStaging";

type AddAssetIntentPanelProps = {
  intent: AddAssetIntent | null;
  onIntentChange: (intent: AddAssetIntent) => void;
  /** Existing timeline placeholder: choose only its provider, then return. */
  providerOnly?: boolean;
};

export function AddAssetIntentPanel({
  intent,
  onIntentChange,
  providerOnly = false,
}: AddAssetIntentPanelProps) {
  const provider = intent?.provider ?? null;
  const methodId = intent?.methodId ?? null;
  const methods = provider ? addAssetMethodsForProvider(provider) : [];
  const selectedMethod = findAddAssetMethod(methodId);
  const canPlace = addAssetIntentAllowsTimelinePlacement(intent);
  const dragDraft = addAssetDragDraftFromIntent(intent);

  const selectProvider = (next: AddAssetProviderId) => {
    const first = addAssetMethodsForProvider(next)[0];
    onIntentChange({
      provider: next,
      methodId: first?.id ?? "blue_timeline_fill",
    });
  };

  const selectMethod = (next: AddAssetMethodId) => {
    if (!provider) return;
    onIntentChange({ provider, methodId: next });
  };

  return (
    <div className="add-asset-generate-pane preview-intent-pane" aria-label="Choose generation method">
      <div className="add-asset-generate-body">
        <header className="preview-intent-header">
          <h2 className="preview-intent-title">
            {providerOnly ? "Choose provider" : "New asset"}
          </h2>
          <p className="muted preview-intent-lede">
            {providerOnly
              ? "Choose who will generate this timeline clip."
              : "Choose how this clip will be created. Timeline methods unlock Place and Drag; other paths will generate into the library."}
          </p>
        </header>

        <section className="add-asset-generate-section">
          <h3>Provider</h3>
          <div className="preview-intent-choice-grid" role="list">
            {ADD_ASSET_PROVIDERS.filter(
              (p) =>
                !providerOnly ||
                p.id === "parascene_blue" ||
                p.id === "replicate",
            ).map((p) => (
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

        {provider && !providerOnly ? (
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

        {!providerOnly && selectedMethod && !selectedMethod.wired ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout">
              <p className="muted" style={{ margin: 0 }}>
                Coming soon — this method is not available yet. Pick Timeline
                video fill under Parascene Blue to place a blank clip and
                generate.
              </p>
            </div>
          </section>
        ) : null}

        {!providerOnly && canPlace ? (
          <section className="add-asset-generate-section">
            <div className="add-asset-generate-callout">
              <p className="muted" style={{ margin: 0 }}>
                Place or drag the clip onto the timeline. Generation options
                open once it is on the timeline.
              </p>
            </div>
          </section>
        ) : null}
      </div>

      {!providerOnly && canPlace ? (
        <div className="add-asset-generate-footer preview-intent-footer">
          <ClipPlaceHandle draft={dragDraft} />
          <ClipDragHandle draft={dragDraft} />
        </div>
      ) : null}
    </div>
  );
}
