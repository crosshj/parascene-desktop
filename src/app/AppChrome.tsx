import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthProvider";
import { OPEN_SETTINGS_EVENT } from "../settings/events";
import { SettingsModal } from "../settings/SettingsModal";
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
  { id: "hook", label: "Publisher" },
  { id: "lab", label: "Lab" },
];

function displayName(
  session: NonNullable<ReturnType<typeof useAuth>["session"]>,
) {
  const handle = session.user.preferred_username?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return session.user.name?.trim() || null;
}

function profilePageUrl(
  session: NonNullable<ReturnType<typeof useAuth>["session"]>,
): string | null {
  const handle = session.user.preferred_username?.trim().replace(/^@/, "");
  if (!handle) return null;
  return `https://www.parascene.com/p/${encodeURIComponent(handle)}`;
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
  const profileUrl = session ? profilePageUrl(session) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const accountRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );

  const showLibraryTabs = primaryTab === "library";
  const showModeTabs = Boolean(openProjectId && primaryTab === "project");
  const showContextTabs = showLibraryTabs || showModeTabs;
  const showChromeStatus =
    Boolean(chromeStatus) &&
    primaryTab === "library" &&
    librarySurface === "creations";

  useEffect(() => {
    if (!menuOpen || !accountRef.current) {
      setMenuPos(null);
      return;
    }
    const rect = accountRef.current.getBoundingClientRect();
    setMenuPos({
      top: Math.round(rect.bottom + 6),
      right: Math.round(window.innerWidth - rect.right),
    });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
    };
    let onPointerDown: ((event: PointerEvent) => void) | undefined;
    const timer = window.setTimeout(() => {
      onPointerDown = (event: PointerEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (accountRef.current?.contains(target)) return;
        if (menuRef.current?.contains(target)) return;
        setMenuOpen(false);
      };
      window.addEventListener("pointerdown", onPointerDown);
    }, 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      if (onPointerDown) {
        window.removeEventListener("pointerdown", onPointerDown);
      }
    };
  }, [menuOpen]);

  const openProfile = () => {
    if (!profileUrl) return;
    setMenuOpen(false);
    void openUrl(profileUrl);
  };

  const openSettings = () => {
    setMenuOpen(false);
    setSettingsOpen(true);
  };

  useEffect(() => {
    const onOpen = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

  const doLogout = () => {
    setMenuOpen(false);
    void logout();
  };

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
        </div>
        {showChromeStatus ? (
          <p className="chrome-status" title={chromeStatus ?? undefined}>
            {chromeStatus}
          </p>
        ) : null}
        <div className="auth-strip">
          {session ? (
            <>
              <button
                ref={accountRef}
                type="button"
                className={`auth-account${menuOpen ? " is-open" : ""}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={name ? `Account menu for ${name}` : "Account menu"}
                onClick={() => setMenuOpen((open) => !open)}
              >
                {session.user.picture ? (
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
              </button>

              {menuOpen && menuPos
                ? createPortal(
                    <div
                      ref={menuRef}
                      className="auth-account-menu"
                      role="menu"
                      aria-label="Account"
                      style={{ top: menuPos.top, right: menuPos.right }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="auth-account-menu-item"
                        role="menuitem"
                        onClick={openSettings}
                      >
                        Settings
                      </button>
                      {profileUrl ? (
                        <button
                          type="button"
                          className="auth-account-menu-item"
                          role="menuitem"
                          onClick={openProfile}
                        >
                          View profile
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="auth-account-menu-item is-logout"
                        role="menuitem"
                        onClick={doLogout}
                      >
                        Log out
                      </button>
                    </div>,
                    document.body,
                  )
                : null}
            </>
          ) : null}
        </div>
      </header>
      <main className="app-main">{children}</main>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
