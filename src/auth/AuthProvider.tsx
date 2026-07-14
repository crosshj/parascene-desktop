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
  cancelLogin,
  loginWithParascene,
  logout as logoutSession,
  restoreSession,
} from "./session";
import { type AuthErrorInfo, toAuthErrorInfo } from "./errors";

type AuthContextValue = {
  status: AuthStatus;
  session: AuthSession | null;
  error: AuthErrorInfo | null;
  login: () => Promise<void>;
  cancelPendingLogin: () => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("reconnecting");
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState<AuthErrorInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled) return;
        if (restored) {
          setSession(restored);
          setStatus("connected");
        } else {
          setStatus("signed_out");
        }
      } catch {
        if (!cancelled) setStatus("signed_out");
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
      setSession(next);
      setStatus("connected");
    } catch (e) {
      setStatus("signed_out");
      setError(toAuthErrorInfo(e));
    }
  }, []);

  const cancelPendingLogin = useCallback(async () => {
    await cancelLogin();
    setStatus("signed_out");
  }, []);

  const logout = useCallback(async () => {
    await logoutSession();
    setSession(null);
    setStatus("signed_out");
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo(
    () => ({
      status,
      session,
      error,
      login,
      cancelPendingLogin,
      logout,
      clearError,
    }),
    [status, session, error, login, cancelPendingLogin, logout, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
