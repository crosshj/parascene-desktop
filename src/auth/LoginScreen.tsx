import { useState } from "react";
import { useAuth } from "./AuthProvider";
import { Wordmark } from "../ui/Wordmark";

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
    <div className="login-screen">
      <div className="login-card">
        <Wordmark />
        <p className="login-copy">Sign in to continue.</p>
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
        {waiting ? (
          <>
            <p className="muted">
              Complete authorization in your browser, then return here.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => cancelPendingLogin()}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn primary login-primary"
            onClick={() => login()}
          >
            Log in
          </button>
        )}
      </div>
    </div>
  );
}
