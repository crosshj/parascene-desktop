import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useShell } from "./ShellProvider";
import type { LayoutMode } from "../project/types";

const MODES: { id: LayoutMode; label: string }[] = [
  { id: "director", label: "Director" },
  { id: "editor", label: "Editor" },
  { id: "hook", label: "Hook" },
];

function displayName(session: NonNullable<ReturnType<typeof useAuth>["session"]>) {
  const handle = session.user.preferred_username?.trim();
  if (handle) return handle.startsWith("@") ? handle : `@${handle}`;
  return session.user.name?.trim() || null;
}

export function AppChrome({ children }: { children: ReactNode }) {
  const { mode, setMode } = useShell();
  const { session, logout } = useAuth();
  const name = session ? displayName(session) : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <nav className="mode-switch" aria-label="Layout mode">
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
