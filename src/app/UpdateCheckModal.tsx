import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
};

type Phase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export function UpdateCheckModal({ open, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [currentVersion, setCurrentVersion] = useState<string>("…");
  const [available, setAvailable] = useState<Update | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number | null }>(
    { loaded: 0, total: null },
  );
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const runCheck = useCallback(async () => {
    const id = ++runId.current;
    setPhase("checking");
    setError(null);
    setAvailable(null);
    setProgress({ loaded: 0, total: null });
    try {
      const version = await getVersion();
      if (id !== runId.current) return;
      setCurrentVersion(version);
      const update = await check();
      if (id !== runId.current) return;
      if (!update) {
        setPhase("up-to-date");
        return;
      }
      setAvailable(update);
      setPhase("available");
    } catch (err) {
      if (id !== runId.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Kick off check when the dialog opens (same pattern as UiDiagnosticsModal).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runCheck();
  }, [open, runCheck]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (phase === "downloading" || phase === "installing") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, phase]);

  const installUpdate = async () => {
    if (!available) return;
    setPhase("downloading");
    setError(null);
    setProgress({ loaded: 0, total: null });
    try {
      await available.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case "Started":
            setProgress({ loaded: 0, total: event.data.contentLength ?? null });
            break;
          case "Progress":
            setProgress((prev) => ({
              loaded: prev.loaded + event.data.chunkLength,
              total: prev.total,
            }));
            break;
          case "Finished":
            setPhase("installing");
            break;
        }
      });
      await relaunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  if (!open) return null;

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const percent =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;

  let body: string;
  switch (phase) {
    case "checking":
      body = "Checking for updates…";
      break;
    case "up-to-date":
      body = `You’re up to date (v${currentVersion}).`;
      break;
    case "available":
      body = `Version ${available?.version ?? "?"} is available (you have v${currentVersion}).`;
      break;
    case "downloading":
      body =
        percent != null
          ? `Downloading update… ${percent}%`
          : "Downloading update…";
      break;
    case "installing":
      body = "Installing update and restarting…";
      break;
    case "error":
      body = error ?? "Update check failed.";
      break;
    default:
      body = "";
  }

  return (
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (busy) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-dialog update-check-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-check-title"
        aria-busy={busy}
      >
        <h2 id="update-check-title">Check for Updates</h2>
        <p>{body}</p>
        {available?.body ? (
          <p className="update-check-notes">{available.body}</p>
        ) : null}
        {phase === "downloading" && percent != null ? (
          <div
            className="update-check-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className="update-check-progress-bar"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
        <div className="confirm-dialog-actions">
          {phase === "available" ? (
            <button type="button" className="btn primary" onClick={() => void installUpdate()}>
              Download & Install
            </button>
          ) : null}
          {phase === "error" ? (
            <button type="button" className="btn primary" onClick={() => void runCheck()}>
              Try again
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            {phase === "available" ? "Later" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
