import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createOAuthState,
  createParasceneSdk,
  createPkcePair,
  isAccessTokenExpiredOrNear,
  type ParasceneSdk,
  type ParasceneUserInfo,
  type TokenSet,
} from "../sdk/parascene";
import {
  PARASCENE_API_BASE_URL_DEFAULT,
  PARASCENE_BASE_URL_DEFAULT,
  PARASCENE_CLIENT_ID,
  PARASCENE_OAUTH_LOOPBACK_PORT,
  PARASCENE_OAUTH_REDIRECT_URI,
} from "../sdk/config";
import {
  AuthFlowError,
  formatUnknownError,
  mapEnsureAccessTokenError,
} from "./errors";

export type AuthStatus =
  | "signed_out"
  | "connecting"
  | "connected"
  | "reconnecting";

export type AuthSession = {
  user: ParasceneUserInfo;
  tokens: TokenSet;
};

const KEYCHAIN_SESSION = "parascene_session";
const ENSURE_TOKEN_TIMEOUT_MS = 8_000;

/** Hot path for Sync/SDK — never block on Keychain/SQLite for a fresh JWT. */
let memorySession: AuthSession | null = null;

/** Keep FE memory in sync with AuthProvider / persist / reauth. */
export function setMemorySession(session: AuthSession | null): void {
  memorySession = session;
}

export function getMemorySession(): AuthSession | null {
  return memorySession;
}

function tokensStillFresh(tokens: TokenSet, skewMs = 60_000): boolean {
  return (
    Boolean(tokens.accessToken) &&
    tokens.expiresAtMs > Date.now() + skewMs &&
    !isAccessTokenExpiredOrNear(tokens.accessToken, skewMs)
  );
}

async function withTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  timeoutMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Older multi-item keys — deleted on read/migrate so Keychain stops prompting for them. */
const LEGACY_KEYCHAIN_KEYS = [
  "parascene_access_token",
  "parascene_refresh_token",
  "parascene_expires_at_ms",
  "parascene_userinfo",
] as const;

type StoredSessionV1 = {
  v: 1;
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  user: ParasceneUserInfo;
};

export function getEnvConfig() {
  return {
    baseUrl:
      import.meta.env.VITE_PARASCENE_BASE_URL || PARASCENE_BASE_URL_DEFAULT,
    apiBaseUrl:
      import.meta.env.VITE_PARASCENE_API_BASE_URL ||
      PARASCENE_API_BASE_URL_DEFAULT,
    clientId: import.meta.env.VITE_PARASCENE_CLIENT_ID || PARASCENE_CLIENT_ID,
    redirectUri: PARASCENE_OAUTH_REDIRECT_URI,
    loopbackPort: PARASCENE_OAUTH_LOOPBACK_PORT,
  };
}

function createSdk(getTokens: () => Promise<TokenSet | null>): ParasceneSdk {
  const { baseUrl, apiBaseUrl, clientId, redirectUri } = getEnvConfig();
  return createParasceneSdk({
    baseUrl,
    apiBaseUrl,
    clientId,
    redirectUri,
    getAccessToken: async () => (await getTokens())?.accessToken ?? null,
    onRefreshNeeded: async () => {
      try {
        await withTimeout(
          ENSURE_TOKEN_TIMEOUT_MS,
          () => invoke<string>("auth_ensure_access_token", { force: true }),
          "Couldn't refresh your Parascene session in time. Try Reconnect.",
        );
      } catch (e: unknown) {
        throw mapEnsureAccessTokenError(e);
      }
      // Prefer store after Rust write; fall back to memory.
      const fromStore = await restoreSession();
      if (fromStore) {
        memorySession = fromStore;
        return fromStore.tokens;
      }
      return memorySession?.tokens ?? null;
    },
  });
}

/** Fresh access token — memory first; Rust refresh only when near expiry. */
export async function ensureAccessToken(): Promise<string> {
  const mem = memorySession?.tokens;
  if (mem && tokensStillFresh(mem)) {
    return mem.accessToken;
  }

  try {
    return await withTimeout(
      ENSURE_TOKEN_TIMEOUT_MS,
      async () => {
        try {
          const tokens = await loadStoredTokens();
          if (tokens && tokensStillFresh(tokens)) {
            return tokens.accessToken;
          }
        } catch {
          /* fall through to Rust */
        }
        const token = await invoke<string>("auth_ensure_access_token", {
          force: false,
        });
        if (memorySession) {
          memorySession = {
            ...memorySession,
            tokens: {
              ...memorySession.tokens,
              accessToken: token,
              // expiresAt unknown here; mark skew window so we don't skip Rust forever
              expiresAtMs: Date.now() + 14 * 60_000,
            },
          };
        }
        return token;
      },
      "Couldn't refresh your Parascene session in time. Try Reconnect.",
    );
  } catch (e: unknown) {
    throw mapEnsureAccessTokenError(e);
  }
}

/** SDK that reads tokens from secure storage and refreshes via Rust when stale. */
export function createAuthedSdk(): ParasceneSdk {
  return createSdk(loadStoredTokens);
}

async function keychainGet(key: string): Promise<string | null> {
  try {
    return await invoke<string | null>("keychain_get", { key });
  } catch {
    return null;
  }
}

async function keychainSet(key: string, value: string): Promise<void> {
  await invoke("keychain_set", { key, value });
}

async function keychainDelete(key: string): Promise<void> {
  await invoke("keychain_delete", { key });
}

async function deleteLegacyKeychainItems(): Promise<void> {
  await Promise.all(LEGACY_KEYCHAIN_KEYS.map((k) => keychainDelete(k)));
}

function encodeSession(session: AuthSession): string {
  const payload: StoredSessionV1 = {
    v: 1,
    accessToken: session.tokens.accessToken,
    refreshToken: session.tokens.refreshToken,
    expiresAtMs: session.tokens.expiresAtMs,
    user: session.user,
  };
  return JSON.stringify(payload);
}

function decodeSession(raw: string): AuthSession | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSessionV1>;
    if (
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      !parsed.user ||
      typeof parsed.user !== "object"
    ) {
      return null;
    }
    return {
      tokens: {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAtMs: Number(parsed.expiresAtMs) || 0,
      },
      user: parsed.user as ParasceneUserInfo,
    };
  } catch {
    return null;
  }
}

/** One secure-storage item for the whole session (Keychain in release, SQLite in debug). */
export async function persistSession(session: AuthSession): Promise<void> {
  memorySession = session;
  await keychainSet(KEYCHAIN_SESSION, encodeSession(session));
  await deleteLegacyKeychainItems();
}

export async function persistTokens(tokens: TokenSet): Promise<void> {
  const existing = memorySession ?? (await restoreSession());
  if (!existing) return;
  await persistSession({ ...existing, tokens });
}

export async function loadStoredTokens(): Promise<TokenSet | null> {
  if (memorySession?.tokens) return memorySession.tokens;
  return (await restoreSession())?.tokens ?? null;
}

export async function clearSecureSession(): Promise<void> {
  memorySession = null;
  await Promise.all([
    keychainDelete(KEYCHAIN_SESSION),
    ...LEGACY_KEYCHAIN_KEYS.map((k) => keychainDelete(k)),
  ]);
}

export async function restoreSession(): Promise<AuthSession | null> {
  const raw = await keychainGet(KEYCHAIN_SESSION);
  if (raw) {
    const session = decodeSession(raw);
    if (session) {
      memorySession = session;
      return session;
    }
  }

  // One-time migrate from the old 4-item layout (then delete legacy keys).
  const accessToken = await keychainGet(LEGACY_KEYCHAIN_KEYS[0]);
  const refreshToken = await keychainGet(LEGACY_KEYCHAIN_KEYS[1]);
  const expiresRaw = await keychainGet(LEGACY_KEYCHAIN_KEYS[2]);
  const userRaw = await keychainGet(LEGACY_KEYCHAIN_KEYS[3]);
  if (!accessToken || !refreshToken || !userRaw) {
    if (accessToken || refreshToken || userRaw) await deleteLegacyKeychainItems();
    return null;
  }
  let user: ParasceneUserInfo;
  try {
    user = JSON.parse(userRaw) as ParasceneUserInfo;
  } catch {
    await deleteLegacyKeychainItems();
    return null;
  }
  const session: AuthSession = {
    tokens: {
      accessToken,
      refreshToken,
      expiresAtMs: Number(expiresRaw) || 0,
    },
    user,
  };
  await persistSession(session);
  return session;
}

type OAuthCallbackPayload = {
  code?: string | null;
  state?: string | null;
  error?: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll Rust for the loopback callback. Do not use Tauri events for this —
 * emit races left the browser "signed in" while the app hung forever.
 */
async function waitForOAuthCallback(
  timeoutMs = 180_000,
): Promise<OAuthCallbackPayload> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await invoke<OAuthCallbackPayload | null>(
      "oauth_take_callback",
    );
    if (payload) return payload;
    await sleep(150);
  }
  void invoke("cancel_oauth_listener");
  throw new Error("oauth_timeout");
}

export type LoginProgressPhase =
  | "browser"
  | "exchanging"
  | "profile"
  | "saving";

/**
 * Real Parascene OAuth — browser consent, loopback return, public-client PKCE exchange.
 */
export async function loginWithParascene(opts?: {
  onProgress?: (phase: LoginProgressPhase) => void;
}): Promise<AuthSession> {
  const cfg = getEnvConfig();
  const sdk = createSdk(loadStoredTokens);
  const state = createOAuthState();
  const { verifier, challenge } = await createPkcePair();

  const breadcrumb = [
    `baseUrl: ${cfg.baseUrl}`,
    `clientId: ${cfg.clientId}`,
    `redirectUri: ${cfg.redirectUri}`,
    `loopbackPort: ${cfg.loopbackPort}`,
  ].join("\n");

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthFlowError) throw err;
      const detail = [
        `Step: ${name}`,
        breadcrumb,
        "",
        formatUnknownError(err),
      ].join("\n");
      throw new AuthFlowError({
        summary: `${name} failed`,
        detail,
        step: name,
      });
    }
  };

  await step("Start OAuth loopback listener", () =>
    invoke<number>("start_oauth_listener", { port: cfg.loopbackPort }),
  );

  const authorizeUrl = sdk.buildAuthorizeUrl({
    state,
    codeChallenge: challenge,
  });

  opts?.onProgress?.("browser");
  await step("Open Parascene authorize in browser", () => openUrl(authorizeUrl));

  const callback = await step("Wait for browser callback", async () => {
    let cb: OAuthCallbackPayload;
    try {
      cb = await waitForOAuthCallback();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "oauth_timeout") {
        throw new AuthFlowError({
          summary: "Browser login timed out",
          detail:
            "No authorization callback arrived within 3 minutes. Cancel, click Reconnect, and complete consent in the browser again.",
          step: "Wait for browser callback",
        });
      }
      throw err;
    }
    if (cb.error) {
      throw new Error(
        cb.error === "cancelled" ? "Login cancelled" : String(cb.error),
      );
    }
    if (!cb.code)
      throw new Error(
        "missing_code — Parascene did not return an authorization code",
      );
    if (cb.state !== state)
      throw new Error("state_mismatch — CSRF check failed");
    return cb;
  });

  opts?.onProgress?.("exchanging");
  const tokens = await step("Exchange code with Parascene (PKCE)", () =>
    withTimeout(
      20_000,
      () =>
        sdk.exchangeAuthorizationCode({
          code: callback.code!,
          codeVerifier: verifier,
        }),
      "Token exchange timed out — check your network and try again",
    ),
  );

  opts?.onProgress?.("profile");
  const authedSdk = createSdk(async () => tokens);
  const user = await step("Fetch /oauth/userinfo", () =>
    withTimeout(
      15_000,
      () => authedSdk.getUserInfo(),
      "Fetching profile timed out — check your network and try again",
    ),
  );

  opts?.onProgress?.("saving");
  await step("Store session", () => persistSession({ tokens, user }));
  return { tokens, user };
}

export async function cancelLogin(): Promise<void> {
  await invoke("cancel_oauth_listener");
}

export async function logout(): Promise<void> {
  await clearSecureSession();
}
