import { useEffect, useState } from "react";
import {
  blueCredentialsClear,
  blueCredentialsSet,
  blueCredentialsStatus,
} from "../blue/blueClient";
import {
  getLabDepsStatus,
  installDemucs,
  openLocalToolsDoc,
  type LabDepsStatus,
} from "../lab/labDeps";
import {
  hydrateOpenAiApiKey,
  saveOpenAiApiKey,
} from "../lab/openaiClient";
import {
  replicateTokenClear,
  replicateTokenSet,
  replicateTokenStatus,
} from "../replicate/replicateClient";
import {
  notifyBlueCredentialsChanged,
  notifyReplicateTokenChanged,
} from "./events";
import {
  DEFAULT_PREVIEW_QUALITY,
  PREVIEW_QUALITY_LABELS,
  PREVIEW_QUALITY_ORDER,
  loadPreviewQuality,
  savePreviewQuality,
  type PreviewQuality,
} from "./previewQuality";

type Props = {
  open: boolean;
  onClose: () => void;
};

const BLUE_CREDS_PLACEHOLDER = `{
  "token": "…",
  "cfAccessClientId": "….access",
  "cfAccessClientSecret": "…"
}`;

/**
 * App settings (account menu): API keys + local tool readiness.
 */
export function SettingsModal({ open, onClose }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [replicateToken, setReplicateToken] = useState("");
  const [replicatePreview, setReplicatePreview] = useState<string | null>(null);
  const [replicateConfigured, setReplicateConfigured] = useState(false);
  const [blueJson, setBlueJson] = useState("");
  const [blueConfigured, setBlueConfigured] = useState(false);
  const [bluePreview, setBluePreview] = useState<string | null>(null);
  const [deps, setDeps] = useState<LabDepsStatus | null>(null);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>(() =>
    loadPreviewQuality(),
  );

  const refreshDeps = async () => {
    setDepsError(null);
    try {
      setDeps(await getLabDepsStatus());
    } catch (err) {
      setDeps(null);
      setDepsError(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshReplicate = async () => {
    try {
      const st = await replicateTokenStatus();
      setReplicateConfigured(st.configured);
      setReplicatePreview(st.preview ?? null);
      setReplicateToken("");
    } catch {
      setReplicateConfigured(false);
      setReplicatePreview(null);
    }
  };

  const refreshBlue = async () => {
    try {
      const st = await blueCredentialsStatus();
      setBlueConfigured(st.configured);
      setBluePreview(st.preview ?? null);
      setBlueJson("");
    } catch {
      setBlueConfigured(false);
      setBluePreview(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    void hydrateOpenAiApiKey().then((key) => setApiKey(key));
    // Intentional: reset the form to persisted values each time the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstallNote(null);
    setPreviewQuality(loadPreviewQuality());
    void refreshDeps();
    void refreshReplicate();
    void refreshBlue();
  }, [open]);

  const onPreviewQualityChange = (index: number) => {
    const next = PREVIEW_QUALITY_ORDER[index] ?? DEFAULT_PREVIEW_QUALITY;
    setPreviewQuality(next);
    // Live-apply: the editor re-fingerprints the preview cache immediately.
    savePreviewQuality(next);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const save = async () => {
    await saveOpenAiApiKey(apiKey);
    try {
      if (replicateToken.trim()) {
        await replicateTokenSet(replicateToken.trim());
        notifyReplicateTokenChanged();
      }
      if (blueJson.trim()) {
        await blueCredentialsSet(blueJson.trim());
        notifyBlueCredentialsChanged();
      }
    } catch (err) {
      setDepsError(err instanceof Error ? err.message : String(err));
      return;
    }
    onClose();
  };

  const clearReplicate = async () => {
    try {
      await replicateTokenClear();
      setReplicateConfigured(false);
      setReplicatePreview(null);
      setReplicateToken("");
      notifyReplicateTokenChanged();
    } catch (err) {
      setDepsError(err instanceof Error ? err.message : String(err));
    }
  };

  const clearBlue = async () => {
    try {
      await blueCredentialsClear();
      setBlueConfigured(false);
      setBluePreview(null);
      setBlueJson("");
      notifyBlueCredentialsChanged();
    } catch (err) {
      setDepsError(err instanceof Error ? err.message : String(err));
    }
  };

  const onInstallDemucs = async () => {
    setInstalling(true);
    setInstallNote("Installing demucs (pip --user)… this can take several minutes.");
    setDepsError(null);
    try {
      const next = await installDemucs();
      setDeps(next);
      setInstallNote(
        next.demucs.ready
          ? `Demucs ready${next.demucs.path ? ` at ${next.demucs.path}` : ""}.`
          : "Install finished but demucs still not detected — see LOCAL_TOOLS.md.",
      );
    } catch (err) {
      setInstallNote(null);
      setDepsError(err instanceof Error ? err.message : String(err));
      void refreshDeps();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={() => onClose()}
    >
      <div
        className="confirm-dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="settings-dialog-title">Settings</h2>
        <div className="settings-form">
          <p className="muted settings-hint">Keys stay on this Mac.</p>
          <label>
            OpenAI API key
            <input
              className="control"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
            />
          </label>
          <p className="muted settings-hint">Lab storyboard and alignment.</p>

          <label>
            Replicate API token
            <input
              className="control"
              type="password"
              value={replicateToken}
              onChange={(e) => setReplicateToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                replicateConfigured
                  ? `Configured (${replicatePreview ?? "••••"}) — paste to replace`
                  : "r8_…"
              }
            />
          </label>
          <p className="muted settings-hint">Lab and editor video fill.</p>
          {replicateConfigured ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void clearReplicate()}
            >
              Clear Replicate token
            </button>
          ) : null}

          <label>
            Parascene Blue credentials (JSON)
            <textarea
              className="control"
              value={blueJson}
              onChange={(e) => setBlueJson(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              rows={6}
              placeholder={
                blueConfigured
                  ? `Configured (${bluePreview ?? "••••"}) — paste JSON to replace`
                  : BLUE_CREDS_PLACEHOLDER
              }
            />
          </label>
          <p className="muted settings-hint">Direct Blue Lab, local import.</p>
          {blueConfigured ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void clearBlue()}
            >
              Clear Blue credentials
            </button>
          ) : null}

          <h3 className="settings-section-title">Editor preview</h3>
          <label htmlFor="settings-preview-quality">
            Timeline preview quality:{" "}
            <strong>{PREVIEW_QUALITY_LABELS[previewQuality]}</strong>
          </label>
          <input
            id="settings-preview-quality"
            className="settings-quality-slider"
            type="range"
            min={0}
            max={PREVIEW_QUALITY_ORDER.length - 1}
            step={1}
            value={PREVIEW_QUALITY_ORDER.indexOf(previewQuality)}
            aria-valuetext={PREVIEW_QUALITY_LABELS[previewQuality]}
            onChange={(e) => onPreviewQualityChange(Number(e.target.value))}
          />
          <div className="settings-quality-scale" aria-hidden="true">
            {PREVIEW_QUALITY_ORDER.map((q) => (
              <span key={q}>{PREVIEW_QUALITY_LABELS[q]}</span>
            ))}
          </div>
          <p className="muted settings-hint">
            Timeline playback only. Export is unchanged.
          </p>

          <h3 className="settings-section-title">Local tools</h3>
          <p className="muted settings-hint">
            System installs. See <code>LOCAL_TOOLS.md</code>.
          </p>
          {deps ? (
            <ul className="settings-tool-list">
              <li>
                <strong>{deps.ffmpeg.label}</strong>
                {deps.ffmpeg.ready ? " — ready" : " — missing"}
                <div className="muted">{deps.ffmpeg.detail}</div>
                {!deps.ffmpeg.ready ? (
                  <code className="settings-install-cmd">
                    {deps.ffmpeg.installHint}
                  </code>
                ) : null}
              </li>
              <li>
                <strong>{deps.demucs.label}</strong>
                {deps.demucs.ready ? " — ready" : " — missing"}
                <div className="muted">{deps.demucs.detail}</div>
                {!deps.demucs.ready ? (
                  <code className="settings-install-cmd">
                    {deps.demucs.installHint}
                  </code>
                ) : null}
              </li>
              <li>
                <strong>{deps.whisper.label}</strong>
                {deps.whisper.ready ? " — ready" : " — missing"}
                <div className="muted">{deps.whisper.detail}</div>
                {!deps.whisper.ready ? (
                  <code className="settings-install-cmd">
                    {deps.whisper.installHint}
                  </code>
                ) : null}
              </li>
            </ul>
          ) : (
            <p className="muted">{depsError ?? "Checking…"}</p>
          )}
          {installNote ? <p className="muted">{installNote}</p> : null}
          {depsError && deps ? (
            <p className="settings-error" role="alert">
              {depsError}
            </p>
          ) : null}
          <div className="settings-tool-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={installing}
              onClick={() => void refreshDeps()}
            >
              Re-check
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={installing || Boolean(deps?.demucs.ready)}
              onClick={() => void onInstallDemucs()}
            >
              {installing ? "Installing demucs…" : "Install demucs"}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={!deps?.docPath}
              title={
                deps?.docPath
                  ? deps.docPath
                  : "LOCAL_TOOLS.md not found (open the git checkout)"
              }
              onClick={() =>
                void openLocalToolsDoc().catch((err) => {
                  setDepsError(err instanceof Error ? err.message : String(err));
                })
              }
            >
              Open LOCAL_TOOLS.md
            </button>
          </div>
        </div>
        <div className="confirm-dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
