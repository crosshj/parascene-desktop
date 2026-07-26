import { useEffect, useState } from "react";
import {
  getLabDepsStatus,
  installDemucs,
  openLocalToolsDoc,
  type LabDepsStatus,
} from "../lab/labDeps";
import {
  loadOpenAiApiKey,
  saveOpenAiApiKey,
} from "../lab/openaiClient";
import {
  replicateTokenClear,
  replicateTokenSet,
  replicateTokenStatus,
} from "../replicate/replicateClient";
import {
  notifyOpenAiKeyChanged,
  notifyReplicateTokenChanged,
} from "./events";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * App settings (account menu): API keys + local tool readiness.
 */
export function SettingsModal({ open, onClose }: Props) {
  const [apiKey, setApiKey] = useState("");
  const [replicateToken, setReplicateToken] = useState("");
  const [replicatePreview, setReplicatePreview] = useState<string | null>(null);
  const [replicateConfigured, setReplicateConfigured] = useState(false);
  const [deps, setDeps] = useState<LabDepsStatus | null>(null);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installNote, setInstallNote] = useState<string | null>(null);

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

  useEffect(() => {
    if (!open) return;
    // Intentional: reset the form to persisted values each time the modal opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setApiKey(loadOpenAiApiKey());
    setInstallNote(null);
    void refreshDeps();
    void refreshReplicate();
  }, [open]);

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
    saveOpenAiApiKey(apiKey);
    notifyOpenAiKeyChanged();
    try {
      if (replicateToken.trim()) {
        await replicateTokenSet(replicateToken.trim());
        notifyReplicateTokenChanged();
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
          <p className="muted settings-hint">
            Stored only on this Mac. Used by Lab tools that call OpenAI (raw
            round-trip, MV storyboard planning).
          </p>

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
          <p className="muted settings-hint">
            Stored in the system keychain. Used only for direct Replicate Lab
            calls — not sent through Parascene.
          </p>
          {replicateConfigured ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => void clearReplicate()}
            >
              Clear Replicate token
            </button>
          ) : null}

          <h3 className="settings-section-title">Local tools</h3>
          <p className="muted settings-hint">
            FFmpeg and Demucs are system installs (not bundled). Full notes:{" "}
            <code>LOCAL_TOOLS.md</code> in the repo.
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
