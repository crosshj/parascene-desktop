import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

const appWindow = () => getCurrentWindow();

/** Compact Windows caption buttons (min / max-restore / close). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    const sync = async () => {
      try {
        const next = await appWindow().isMaximized();
        if (!disposed) setMaximized(next);
      } catch {
        // Non-Tauri / missing capability.
      }
    };
    void sync();
    let unlisten: (() => void) | undefined;
    void appWindow()
      .onResized(() => {
        void sync();
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="window-controls" aria-label="Window">
      <button
        type="button"
        className="window-control"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void appWindow().minimize()}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path fill="currentColor" d="M1 5.5h10v1H1z" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void appWindow().toggleMaximize()}
      >
        {maximized ? (
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path
              fill="currentColor"
              d="M3.5 1.5h7v7h-1v-6h-6v-1zm-2 2h7v7h-7v-7zm1 1v5h5v-5h-5z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path
              fill="currentColor"
              d="M1.5 1.5h9v9h-9v-9zm1 1v7h7v-7h-7z"
            />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control is-close"
        title="Close"
        aria-label="Close"
        onClick={() => void appWindow().close()}
      >
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
          <path
            fill="currentColor"
            d="M2.1 1.4 6 5.3l3.9-3.9.7.7L6.7 6l3.9 3.9-.7.7L6 6.7l-3.9 3.9-.7-.7L5.3 6 1.4 2.1z"
          />
        </svg>
      </button>
    </div>
  );
}
