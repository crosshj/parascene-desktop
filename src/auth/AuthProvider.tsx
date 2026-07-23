import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  type AuthSession,
  type AuthStatus,
  type LoginProgressPhase,
  cancelLogin,
  loginWithParascene,
  logout as logoutSession,
  restoreSession,
  setMemorySession,
} from "./session";
import { type AuthErrorInfo, toAuthErrorInfo } from "./errors";

type AuthContextValue = {
  status: AuthStatus;
  session: AuthSession | null;
  error: AuthErrorInfo | null;
  login: () => Promise<void>;
  /** In-app OAuth refresh — keeps the shell mounted; does not sign out. */
  reauth: () => Promise<boolean>;
  reauthPending: boolean;
  reauthPhase: LoginProgressPhase | null;
  reauthError: AuthErrorInfo | null;
  cancelPendingLogin: () => Promise<void>;
  cancelPendingReauth: () => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  clearReauthError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function adoptSession(session: AuthSession | null) {
  setMemorySession(session);
  return session;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("reconnecting");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<AuthErrorInfo | null>(null);
  const [reauthPending, setReauthPending] = useState(false);
  const [reauthPhase, setReauthPhase] = useState<LoginProgressPhase | null>(
    null,
  );
  const [reauthError, setReauthError] = useState<AuthErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled) return;
        if (restored) {
          setSession(adoptSession(restored));
          setStatus("connected");
        } else {
          adoptSession(null);
          setStatus("signed_out");
        }
      } catch {
        if (!cancelled) {
          adoptSession(null);
          setStatus("signed_out");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    try {
      const next = await loginWithParascene();
      setSession(adoptSession(next));
      setStatus("connected");
    } catch (e) {
      adoptSession(null);
      setStatus("signed_out");
      setError(toAuthErrorInfo(e));
    }
  }, []);

  const reauth = useCallback(async () => {
    setReauthError(null);
    setReauthPending(true);
    setReauthPhase("browser");
    try {
      const next = await loginWithParascene({
        onProgress: (phase) => setReauthPhase(phase),
      });
      setSession(adoptSession(next));
      setStatus("connected");
      setReauthPending(false);
      setReauthPhase(null);
      return true;
    } catch (e) {
      setReauthPending(false);
      setReauthPhase(null);
      const info = toAuthErrorInfo(e);
      // Cancel from the overlay — don't replace the app with an error card.
      if (/cancell?ed/i.test(info.summary) || /cancell?ed/i.test(info.detail)) {
        return false;
      }
      setReauthError(info);
      return false;
    }
  }, []);

  const cancelPendingLogin = useCallback(async () => {
    await cancelLogin();
    setStatus("signed_out");
  }, []);

  const cancelPendingReauth = useCallback(async () => {
    await cancelLogin();
    setReauthPending(false);
    setReauthPhase(null);
  }, []);

  const logout = useCallback(async () => {
    await logoutSession();
    setSession(adoptSession(null));
    setStatus("signed_out");
    setError(null);
    setReauthPending(false);
    setReauthPhase(null);
    setReauthError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const clearReauthError = useCallback(() => setReauthError(null), []);

  const value = useMemo(
    () => ({
      status,
      session,
      error,
      login,
      reauth,
      reauthPending,
      reauthPhase,
      reauthError,
      cancelPendingLogin,
      cancelPendingReauth,
      logout,
      clearError,
      clearReauthError,
    }),
    [
      status,
      session,
      error,
      login,
      reauth,
      reauthPending,
      reauthPhase,
      reauthError,
      cancelPendingLogin,
      cancelPendingReauth,
      logout,
      clearError,
      clearReauthError,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
