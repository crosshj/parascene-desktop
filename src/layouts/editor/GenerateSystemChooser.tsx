/**
 * Stable System roster for Generate forms.
 *
 * Roster = Settings-enabled systems from a settled credential cache. Flipping
 * assets must not add/remove cards. A historic system that is not enabled today
 * is stated below the list — it is not injected into the roster.
 */

import {
  GENERATE_SERVERS,
  type GenerateServerId,
} from "./previewIntent";
import { GenerateServerIcon } from "./GenerateServerIcon";
import {
  settledEnabledGenerateServerIds,
  useGenerateServerCredentials,
} from "./generateServerCredentials";

type GenerateSystemChooserProps = {
  selectedId: GenerateServerId | null;
  disabled?: boolean;
  onSelect: (id: GenerateServerId) => void;
};

export function GenerateSystemChooser({
  selectedId,
  disabled = false,
  onSelect,
}: GenerateSystemChooserProps) {
  const creds = useGenerateServerCredentials();
  const enabledIds = settledEnabledGenerateServerIds(creds);

  const roster = GENERATE_SERVERS.filter((def) =>
    enabledIds.includes(def.id),
  );

  const historicDef =
    selectedId && !enabledIds.includes(selectedId)
      ? (GENERATE_SERVERS.find((def) => def.id === selectedId) ?? null)
      : null;

  return (
    <section className="add-asset-generate-section">
      <h3>System</h3>
      <div className="preview-intent-choice-grid" role="list">
        {roster.map((def) => {
          const selected = selectedId === def.id;
          return (
            <button
              key={def.id}
              type="button"
              role="listitem"
              className={`preview-intent-choice preview-intent-choice--compact${
                selected ? " is-selected" : ""
              }`}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onSelect(def.id)}
            >
              <span className="preview-intent-choice-icon preview-intent-choice-icon--brand">
                <GenerateServerIcon serverId={def.id} />
              </span>
              <span className="preview-intent-choice-text">
                <span className="preview-intent-choice-label">{def.label}</span>
                <span className="muted preview-intent-choice-desc">
                  {def.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {historicDef ? (
        <p className="muted add-asset-generate-note" style={{ margin: 0 }}>
          Used {historicDef.label} for this generation.
        </p>
      ) : null}
    </section>
  );
}
