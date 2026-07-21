import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ConfirmActivity = {
  setMessage: (message: string) => void;
};

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Hide the cancel button (alert-style: only OK). */
  hideCancel?: boolean;
  /** Emphasize the confirm action as destructive. */
  danger?: boolean;
  /** Title shown when `onConfirm` throws. */
  errorTitle?: string;
  /**
   * When set, the dialog stays open after confirm and runs this work while
   * showing the message as an activity indicator (`setMessage` for progress).
   */
  onConfirm?: (activity: ConfirmActivity) => Promise<void>;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

type Pending = ConfirmOptions & {
  resolve: (value: boolean) => void;
  busy?: boolean;
  displayMessage: string;
  displayTitle: string;
  errorMode?: boolean;
};

/**
 * App-wide confirm dialog — use instead of `window.confirm` (unreliable in Tauri).
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, message, danger: true }))) return;
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const close = useCallback((value: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(value);
  }, []);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // Replace any open confirm (resolve previous as cancelled).
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
      }
      const next: Pending = {
        ...options,
        resolve,
        displayTitle: options.title,
        displayMessage: options.message,
      };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const runConfirm = useCallback(async () => {
    const current = pendingRef.current;
    if (!current || current.busy) return;

    if (!current.onConfirm) {
      close(true);
      return;
    }

    const busy: Pending = {
      ...current,
      busy: true,
      hideCancel: true,
      displayMessage: current.displayMessage || "Working…",
    };
    pendingRef.current = busy;
    setPending(busy);

    try {
      await current.onConfirm({
        setMessage: (message) => {
          const trimmed = message.trim();
          if (!trimmed) return;
          setPending((prev) => {
            if (!prev || !prev.busy) return prev;
            const next = { ...prev, displayMessage: trimmed };
            pendingRef.current = next;
            return next;
          });
        },
      });
      close(true);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const failed: Pending = {
        ...current,
        busy: false,
        errorMode: true,
        hideCancel: true,
        onConfirm: undefined,
        displayTitle: current.errorTitle ?? "Could not complete action",
        displayMessage: detail,
        confirmLabel: "OK",
        danger: false,
      };
      pendingRef.current = failed;
      setPending(failed);
    }
  }, [close]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pending.busy) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        // Alert-style dialogs treat Escape as acknowledge.
        close(pending.hideCancel ? true : false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  const value = useMemo(() => confirm, [confirm]);

  const dismiss = (value: boolean) => {
    if (pending?.busy) return;
    close(value);
  };

  const dismissFromBackdrop = () => {
    if (!pending || pending.busy) return;
    if (pending.errorMode) {
      dismiss(false);
      return;
    }
    dismiss(pending.hideCancel ? true : false);
  };

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onClick={dismissFromBackdrop}
        >
          <div
            className={[
              "confirm-dialog",
              pending.busy ? "is-busy" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            aria-busy={pending.busy ? true : undefined}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-dialog-title">{pending.displayTitle}</h2>
            <p id="confirm-dialog-message" className="muted">
              {pending.displayMessage}
            </p>
            {pending.busy ? (
              <div
                className="confirm-dialog-activity"
                role="status"
                aria-live="polite"
              >
                <span className="confirm-dialog-spinner" aria-hidden />
                <span>Please wait…</span>
              </div>
            ) : null}
            <div className="confirm-dialog-actions">
              {pending.hideCancel ? null : (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => dismiss(false)}
                >
                  {pending.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                type="button"
                className={pending.danger ? "btn btn-danger" : "btn btn-primary"}
                autoFocus={!pending.busy}
                disabled={pending.busy}
                onClick={() => {
                  if (pending.errorMode) {
                    dismiss(false);
                    return;
                  }
                  if (pending.hideCancel || !pending.onConfirm) {
                    dismiss(true);
                    return;
                  }
                  void runConfirm();
                }}
              >
                {pending.busy
                  ? "Working…"
                  : (pending.confirmLabel ?? "OK")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used within ConfirmProvider");
  }
  return confirm;
}
