import { useAuth } from "./AuthProvider";
import type { LoginProgressPhase } from "./session";

function reauthCopy(phase: LoginProgressPhase | null): {
  title: string;
  body: string;
  showCancel: boolean;
} {
  switch (phase) {
    case "exchanging":
      return {
        title: "Finishing sign-in…",
        body: "Browser auth succeeded. Exchanging the code with Parascene…",
        showCancel: false,
      };
    case "profile":
      return {
        title: "Finishing sign-in…",
        body: "Loading your Parascene profile…",
        showCancel: false,
      };
    case "saving":
      return {
        title: "Finishing sign-in…",
        body: "Saving your session…",
        showCancel: false,
      };
    case "browser":
    default:
      return {
        title: "Authorize in your browser",
        body: "Complete sign-in on Parascene. This dialog closes automatically when the browser returns — you do not need to click anything here.",
        showCancel: true,
      };
  }
}

/** Non-destructive reauth: keep the app mounted while the browser finishes OAuth. */
export function ReauthOverlay() {
  const {
    reauthPending,
    reauthPhase,
    reauthError,
    cancelPendingReauth,
    clearReauthError,
    reauth,
  } = useAuth();

  if (!reauthPending && !reauthError) return null;

  const copy = reauthCopy(reauthPhase);

  return (
    <div
      className="reauth-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="reauth-card">
        <h2 id="reauth-title" className="reauth-title">
          {reauthPending ? copy.title : "Reconnect needed"}
        </h2>
        {reauthPending ? (
          <>
            <p className="muted">{copy.body}</p>
            {copy.showCancel ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void cancelPendingReauth();
                }}
              >
                Cancel
              </button>
            ) : null}
          </>
        ) : (
          <>
            {reauthError ? (
              <p className="library-error" role="alert">
                {reauthError.summary}
              </p>
            ) : null}
            <div className="reauth-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void reauth();
                }}
              >
                Try again
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => clearReauthError()}
              >
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
