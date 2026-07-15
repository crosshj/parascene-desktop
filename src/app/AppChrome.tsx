import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import {
  useShell,
  type LibrarySurface,
  type PrimaryTab,
} from "./ShellProvider";
import type { LayoutMode } from "../project/types";

const PRIMARY_TABS: { id: PrimaryTab; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "project", label: "Project" },
];

const LIBRARY_TABS: { id: LibrarySurface; label: string }[] = [
  { id: "creations", label: "Creations" },
  { id: "sync", label: "Sync" },
];

const MODES: { id: LayoutMode; label: string }[] = [
  { id: "director", label: "Director" },
  { id: "editor", label: "Editor" },
  { id: "hook", label: "Hook" },
];

function displayName(
  session: NonNullable<ReturnType<typeof useAuth>["session"]>,
) {
  const handle = session.user.preferred_username?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return session.user.name?.trim() || null;
}

export function AppChrome({ children }: { children: ReactNode }) {
  const {
    primaryTab,
    setPrimaryTab,
    librarySurface,
    setLibrarySurface,
    mode,
    setMode,
    openProjectId,
    chromeStatus,
  } = useShell();
  const { session, logout } = useAuth();
  const name = session ? displayName(session) : null;
  const showLibraryTabs = primaryTab === "library";
  const showModeTabs = Boolean(openProjectId && primaryTab === "project");
  const showContextTabs = showLibraryTabs || showModeTabs;
  const showChromeStatus =
    Boolean(chromeStatus) && primaryTab === "library" && librarySurface === "creations";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="chrome-nav">
          <nav className="primary-tabs" aria-label="Primary">
            {PRIMARY_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={
                  primaryTab === t.id ? "mode-btn active" : "mode-btn"
                }
                aria-pressed={primaryTab === t.id}
                onClick={() => setPrimaryTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {showContextTabs ? (
            <span className="chrome-spacer" aria-hidden>
              <span className="chrome-divider" />
            </span>
          ) : null}

          {showLibraryTabs ? (
            <nav className="context-tabs" aria-label="Library">
              {LIBRARY_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={
                    librarySurface === t.id ? "mode-btn active" : "mode-btn"
                  }
                  aria-pressed={librarySurface === t.id}
                  onClick={() => setLibrarySurface(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          ) : null}

          {showModeTabs ? (
            <nav className="context-tabs" aria-label="Layout mode">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={mode === m.id ? "mode-btn active" : "mode-btn"}
                  aria-pressed={mode === m.id}
                  onClick={() => setMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </nav>
          ) : null}

          {/* Former always-on mode switch — replaced by context tabs after spacer.
          <nav className="mode-switch" aria-label="Layout mode">...</nav>
          */}
        </div>
        {showChromeStatus ? (
          <p className="chrome-status" title={chromeStatus ?? undefined}>
            {chromeStatus}
          </p>
        ) : null}
        <div className="auth-strip">
          {session?.user.picture ? (
            <img
              className="avatar"
              src={session.user.picture}
              alt=""
              width={28}
              height={28}
            />
          ) : (
            <span className="avatar avatar-fallback" aria-hidden>
              {(name || "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
            </span>
          )}
          {name ? <span className="auth-name">{name}</span> : null}
          <button type="button" className="btn" onClick={() => logout()}>
            Log out
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
