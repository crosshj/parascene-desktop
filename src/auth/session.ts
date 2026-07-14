import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createOAuthState,
  createParasceneSdk,
  createPkcePair,
  type ParasceneSdk,
  type ParasceneUserInfo,
  type TokenSet,
} from "../sdk/parascene";
import {
  PARASCENE_BASE_URL_DEFAULT,
  PARASCENE_CLIENT_ID,
  PARASCENE_OAUTH_LOOPBACK_PORT,
  PARASCENE_OAUTH_REDIRECT_URI,
} from "../sdk/config";
import { AuthFlowError, formatUnknownError } from "./errors";

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
    clientId: import.meta.env.VITE_PARASCENE_CLIENT_ID || PARASCENE_CLIENT_ID,
    redirectUri: PARASCENE_OAUTH_REDIRECT_URI,
    loopbackPort: PARASCENE_OAUTH_LOOPBACK_PORT,
  };
}

function createSdk(getTokens: () => Promise<TokenSet | null>): ParasceneSdk {
  const { baseUrl, clientId, redirectUri } = getEnvConfig();
  return createParasceneSdk({
    baseUrl,
    clientId,
    redirectUri,
    getAccessToken: async () => (await getTokens())?.accessToken ?? null,
    onRefreshNeeded: async () => {
      const current = await getTokens();
      if (!current?.refreshToken) return null;
      const sdk = createParasceneSdk({
        baseUrl,
        clientId,
        redirectUri,
        getAccessToken: async () => current.accessToken,
      });
      const next = await sdk.refreshTokens(current.refreshToken);
      await persistTokens(next);
      return next;
    },
  });
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

/** One Keychain item for the whole session (avoids multiple OS password prompts). */
export async function persistSession(session: AuthSession): Promise<void> {
  await keychainSet(KEYCHAIN_SESSION, encodeSession(session));
  await deleteLegacyKeychainItems();
}

export async function persistTokens(tokens: TokenSet): Promise<void> {
  const existing = await restoreSession();
  if (!existing) return;
  await persistSession({ ...existing, tokens });
}

export async function loadStoredTokens(): Promise<TokenSet | null> {
  return (await restoreSession())?.tokens ?? null;
}

export async function clearSecureSession(): Promise<void> {
  await Promise.all([
    keychainDelete(KEYCHAIN_SESSION),
    ...LEGACY_KEYCHAIN_KEYS.map((k) => keychainDelete(k)),
  ]);
}

export async function restoreSession(): Promise<AuthSession | null> {
  const raw = await keychainGet(KEYCHAIN_SESSION);
  if (raw) {
    const session = decodeSession(raw);
    if (session) return session;
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

function waitForOAuthCallback(timeoutMs = 180_000): Promise<OAuthCallbackPayload> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("oauth_timeout")));
      void invoke("cancel_oauth_listener");
    }, timeoutMs);

    void listen<OAuthCallbackPayload>("oauth-callback", (event) => {
      finish(() => resolve(event.payload));
    }).then((off) => {
      unlisten = off;
    });
  });
}

/**
 * Real Parascene OAuth — browser consent, loopback return, public-client PKCE exchange.
 */
export async function loginWithParascene(): Promise<AuthSession> {
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

  const callbackPromise = waitForOAuthCallback();

  const authorizeUrl = sdk.buildAuthorizeUrl({
    state,
    codeChallenge: challenge,
  });

  await step("Open Parascene authorize in browser", () => openUrl(authorizeUrl));

  const callback = await step("Wait for browser callback", async () => {
    const cb = await callbackPromise;
    if (cb.error) {
      throw new Error(
        cb.error === "cancelled" ? "Login cancelled" : String(cb.error),
      );
    }
    if (!cb.code) throw new Error("missing_code — Parascene did not return an authorization code");
    if (cb.state !== state) throw new Error("state_mismatch — CSRF check failed");
    return cb;
  });

  const tokens = await step("Exchange code with Parascene (PKCE)", () =>
    sdk.exchangeAuthorizationCode({
      code: callback.code!,
      codeVerifier: verifier,
    }),
  );

  const authedSdk = createSdk(async () => tokens);
  const user = await step("Fetch /oauth/userinfo", () => authedSdk.getUserInfo());
  await step("Store session in Keychain", () =>
    persistSession({ tokens, user }),
  );
  return { tokens, user };
}

export async function cancelLogin(): Promise<void> {
  await invoke("cancel_oauth_listener");
}

export async function logout(): Promise<void> {
  await clearSecureSession();
}
