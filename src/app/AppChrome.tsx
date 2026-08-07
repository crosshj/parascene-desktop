import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  getUserAvatarDisplay,
  rejectUserAvatarDisplay,
  subscribeUserAvatarDisplay,
} from "../sync/avatarSync";
import { OPEN_SETTINGS_EVENT } from "../settings/events";
import {
  OPEN_UI_DIAGNOSTICS_EVENT,
  UNLOCK_UI_EVENT,
  requestOpenUiDiagnostics,
  requestUnlockUi,
} from "./diagnosticsEvents";
import { CHECK_UPDATES_EVENT, requestCheckUpdates } from "./updateEvents";
import { SettingsModal } from "../settings/SettingsModal";
import { UiDiagnosticsModal } from "./UiDiagnosticsModal";
import { UpdateCheckModal } from "./UpdateCheckModal";
import { installPointerCaptureSpy, unlockUi } from "./uiDiagnostics";
import { useShell, type LibrarySurface } from "./ShellProvider";
import type { LayoutMode } from "../project/types";
import { WindowControls } from "./WindowControls";
import { isWindowsDesktop } from "./windowPlatform";
import { ParasceneMark } from "../ui/ParasceneMark";

type ShellTab =
  | { kind: "library"; surface: LibrarySurface; label: string }
  | { kind: "project"; label: string };

const SHELL_TABS: ShellTab[] = [
  { kind: "library", surface: "creations", label: "Library" },
  { kind: "library", surface: "sync", label: "Sync" },
  { kind: "project", label: "Project" },
];

const MODES: { id: LayoutMode; label: string }[] = [
  { id: "director", label: "Director" },
  { id: "editor", label: "Editor" },
  { id: "hook", label: "Publisher" },
  { id: "lab", label: "Labs" },
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

function AccountAvatar({
  name,
}: {
  name: string | null;
}) {
  const avatar = useSyncExternalStore(
    subscribeUserAvatarDisplay,
    getUserAvatarDisplay,
    getUserAvatarDisplay,
  );
  const initial = (name || "?").replace(/^@/, "").slice(0, 1).toUpperCase();

  // Never render an unverified remote URL — placeholder until local file is ready.
  if (avatar.src) {
    return (
      <img
        className="avatar"
        src={avatar.src}
        alt=""
        width={28}
        height={28}
        onError={() => rejectUserAvatarDisplay("Image failed to load")}
      />
    );
  }

  return (
    <span className="avatar avatar-fallback" aria-hidden>
      {initial}
    </span>
  );
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
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [updateCheckOpen, setUpdateCheckOpen] = useState(false);
  const [isWindows] = useState(() => isWindowsDesktop());
  const accountRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(
    null,
  );

  const showModeTabs = Boolean(openProjectId);
  const showChromeStatus =
    Boolean(chromeStatus) &&
    primaryTab === "library" &&
    librarySurface === "creations";

  const shellTabActive = (tab: ShellTab) => {
    if (tab.kind === "project") return primaryTab === "project";
    return primaryTab === "library" && librarySurface === tab.surface;
  };

  const goShellTab = (tab: ShellTab) => {
    if (tab.kind === "project") {
      setPrimaryTab("project");
      return;
    }
    setLibrarySurface(tab.surface);
    setPrimaryTab("library");
  };

  const goMode = (next: LayoutMode) => {
    setMode(next);
    setPrimaryTab("project");
  };

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

  const openDiagnostics = () => {
    setMenuOpen(false);
    setDiagnosticsOpen(true);
  };

  const openUpdateCheck = () => {
    setMenuOpen(false);
    setUpdateCheckOpen(true);
  };

  const runUnlockUi = () => {
    setMenuOpen(false);
    unlockUi();
  };

  useEffect(() => {
    installPointerCaptureSpy();
  }, []);

  useEffect(() => {
    const onOpen = () => setSettingsOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const onOpen = () => setDiagnosticsOpen(true);
    const onUnlock = () => {
      unlockUi();
    };
    const onCheckUpdates = () => setUpdateCheckOpen(true);
    window.addEventListener(OPEN_UI_DIAGNOSTICS_EVENT, onOpen);
    window.addEventListener(UNLOCK_UI_EVENT, onUnlock);
    window.addEventListener(CHECK_UPDATES_EVENT, onCheckUpdates);
    return () => {
      window.removeEventListener(OPEN_UI_DIAGNOSTICS_EVENT, onOpen);
      window.removeEventListener(UNLOCK_UI_EVENT, onUnlock);
      window.removeEventListener(CHECK_UPDATES_EVENT, onCheckUpdates);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const unsubs: Array<() => void> = [];
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (disposed) return;
        unsubs.push(
          await listen("parascene:ui-diagnose", () => {
            requestOpenUiDiagnostics();
          }),
        );
        unsubs.push(
          await listen("parascene:ui-unlock", () => {
            requestUnlockUi();
          }),
        );
        unsubs.push(
          await listen("parascene:check-updates", () => {
            requestCheckUpdates();
          }),
        );
      } catch {
        // Browser tests / non-Tauri runtime.
      }
    })();
    return () => {
      disposed = true;
      for (const unsub of unsubs) unsub();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "d") {
        event.preventDefault();
        requestOpenUiDiagnostics();
        return;
      }
      if (key === "u") {
        event.preventDefault();
        requestUnlockUi();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const doLogout = () => {
    setMenuOpen(false);
    void logout();
  };

  const onHeaderDoubleClick = (event: MouseEvent) => {
    if (!isWindows) return;
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button, a, input, select, textarea, [role='menu']")) {
      return;
    }
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize())
      .catch(() => {});
  };

  return (
    <div className={`app-shell${isWindows ? " is-windows" : ""}`}>
      <header
        className="app-header"
        data-tauri-drag-region={isWindows ? true : undefined}
        onDoubleClick={onHeaderDoubleClick}
      >
        <span className="app-brand-mark" role="img" aria-label="Parascene Desktop">
          <ParasceneMark />
        </span>
        <div className="chrome-nav">
          <nav className="primary-tabs" aria-label="Primary">
            {SHELL_TABS.map((tab) => {
              const key =
                tab.kind === "project" ? "project" : `library-${tab.surface}`;
              const active = shellTabActive(tab);
              return (
                <button
                  key={key}
                  type="button"
                  className={active ? "mode-btn active" : "mode-btn"}
                  aria-pressed={active}
                  onClick={() => goShellTab(tab)}
                >
                  {tab.label}
                </button>
              );
            })}
          </nav>

          {showModeTabs ? (
            <>
              <span className="chrome-spacer" aria-hidden>
                <span className="chrome-divider" />
              </span>
              <nav className="context-tabs" aria-label="Layout mode">
                {MODES.map((m) => {
                  const active = primaryTab === "project" && mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={active ? "mode-btn active" : "mode-btn"}
                      aria-pressed={active}
                      onClick={() => goMode(m.id)}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </nav>
            </>
          ) : null}
        </div>
        {isWindows ? (
          <div className="chrome-drag-fill" data-tauri-drag-region aria-hidden />
        ) : null}
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
                <AccountAvatar name={name} />
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
                      <button
                        type="button"
                        className="auth-account-menu-item"
                        role="menuitem"
                        onClick={openUpdateCheck}
                      >
                        Check for Updates…
                      </button>
                      <button
                        type="button"
                        className="auth-account-menu-item"
                        role="menuitem"
                        onClick={openDiagnostics}
                      >
                        Diagnose UI…
                      </button>
                      <button
                        type="button"
                        className="auth-account-menu-item"
                        role="menuitem"
                        onClick={runUnlockUi}
                      >
                        Unlock UI
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
        {isWindows ? <WindowControls /> : null}
      </header>
      <main className="app-main">{children}</main>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <UiDiagnosticsModal
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
      />
      <UpdateCheckModal
        open={updateCheckOpen}
        onClose={() => setUpdateCheckOpen(false)}
      />
    </div>
  );
}
