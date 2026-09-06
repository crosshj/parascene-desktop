import { useState, type ReactNode } from "react";
import { WindowControls } from "../app/WindowControls";
import { isWindowsDesktop } from "../app/windowPlatform";
import { openHelpWindow } from "../help/openHelpWindow";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { Wordmark } from "../ui/Wordmark";
import { useAuth } from "./AuthProvider";

export function LoginShell({ children }: { children: ReactNode }) {
  const windows = isWindowsDesktop();
  return (
    <div className={`login-screen${windows ? " is-windows" : ""}`}>
      {windows ? (
        <header className="login-chrome">
          <div className="login-chrome-drag" data-tauri-drag-region aria-hidden />
          <WindowControls />
        </header>
      ) : (
        <div className="login-chrome-drag login-chrome-drag-mac" data-tauri-drag-region aria-hidden />
      )}
      <div className="login-stage">{children}</div>
    </div>
  );
}

export function LoginCard({ children }: { children: ReactNode }) {
  return (
    <div className="login-card">
      <Wordmark className="wordmark login-wordmark" width={300} />
      {children}
    </div>
  );
}

export function LoginScreen() {
  const { status, error, login, cancelPendingLogin } = useAuth();
  const waiting = status === "connecting";
  const [copied, setCopied] = useState(false);

  const copyDetails = async () => {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error.detail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <LoginShell>
      <LoginCard>
        {waiting ? (
          <>
            <h1 className="login-title">Waiting for your browser</h1>
            <p className="login-copy">
              Finish sign-in on Parascene, then return here. This screen
              updates on its own.
            </p>
            <p className="muted login-wait-hint">
              Taking too long? Cancel and try again — waiting forever usually
              means the browser tab never finished.
            </p>
            <div className="login-actions">
              <button
                type="button"
                className="btn login-secondary"
                onClick={() => cancelPendingLogin()}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 className="login-title">Sign in to continue.</h1>
            <p className="login-copy">
              Use your Parascene account. A browser window will open to
              authorize this app.
            </p>
            {error ? (
              <div className="auth-error login-error" role="alert">
                <div className="login-error-summary">
                  {error.step ? (
                    <span className="login-error-step">{error.step}</span>
                  ) : null}
                  <strong>{error.summary}</strong>
                </div>
                <details className="login-error-details">
                  <summary>Technical details</summary>
                  <pre className="login-error-pre">{error.detail}</pre>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => copyDetails()}
                  >
                    {copied ? "Copied" : "Copy details"}
                  </button>
                </details>
              </div>
            ) : null}
            <div className="login-actions">
              <button
                type="button"
                className="btn primary login-primary"
                onClick={() => login()}
              >
                Log in
              </button>
            </div>
          </>
        )}
        <button
          type="button"
          className="login-help"
          onClick={() => void openHelpWindow()}
        >
          <BookOpen
            className="login-help-book"
            size={18}
            strokeWidth={1.5}
            aria-hidden
          />
          <span>Help documentation</span>
          <ArrowUpRight
            className="login-help-arrow"
            size={14}
            strokeWidth={1.5}
            aria-hidden
          />
        </button>
      </LoginCard>
    </LoginShell>
  );
}
