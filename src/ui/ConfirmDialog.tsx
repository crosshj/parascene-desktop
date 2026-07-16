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

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Hide the cancel button (alert-style: only OK). */
  hideCancel?: boolean;
  /** Emphasize the confirm action as destructive. */
  danger?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

type Pending = ConfirmOptions & {
  resolve: (value: boolean) => void;
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
      const next: Pending = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Alert-style dialogs treat Escape as acknowledge.
        close(pending.hideCancel ? true : false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onClick={() => close(pending.hideCancel ? true : false)}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-dialog-title">{pending.title}</h2>
            <p id="confirm-dialog-message" className="muted">
              {pending.message}
            </p>
            <div className="confirm-dialog-actions">
              {pending.hideCancel ? null : (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => close(false)}
                >
                  {pending.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                type="button"
                className={pending.danger ? "btn btn-danger" : "btn btn-primary"}
                autoFocus
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? "OK"}
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
