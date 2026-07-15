/** Parascene HTTP SDK — all product API interaction goes through here. */

import { invoke } from "@tauri-apps/api/core";

export type ParasceneUserInfo = {
  sub: string;
  preferred_username?: string;
  name?: string;
  picture?: string;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
};

export type ParasceneSdkConfig = {
  baseUrl: string;
  /** Defaults to `baseUrl` when omitted (override with `https://api.parascene.com`). */
  apiBaseUrl?: string;
  clientId: string;
  redirectUri: string;
  getAccessToken: () => Promise<string | null>;
  onRefreshNeeded?: () => Promise<TokenSet | null>;
};

/** Row from `GET /api/create/images` (snake_case as returned by Parascene). */
export type RemoteCreateImage = {
  id: number | string;
  filename?: string | null;
  url?: string | null;
  thumbnail_url?: string | null;
  video_url?: string | null;
  media_type?: string | null;
  title?: string | null;
  description?: string | null;
  published?: boolean;
  published_at?: string | null;
  created_at?: string | null;
  status?: string | null;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  nsfw?: boolean;
  is_moderated_error?: boolean;
  challenge_ended?: boolean;
  meta?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type ListCreateImagesResult = {
  images: RemoteCreateImage[];
  hasMore: boolean;
};

type HttpJsonResult = { status: number; body: string };

type OAuthTokenResponse = {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

function normalizeBase(url: string): string {
  return url.replace(/\/$/, "");
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64url(raw);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: b64url(digest) };
}

export function createOAuthState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

async function postJson(url: string, payload: unknown): Promise<HttpJsonResult> {
  return invoke<HttpJsonResult>("http_post_json", {
    url,
    body: JSON.stringify(payload),
  });
}

async function getBearer(url: string, bearer: string): Promise<HttpJsonResult> {
  return invoke<HttpJsonResult>("http_get_bearer", { url, bearer });
}

function tokenSetFromResponse(data: OAuthTokenResponse, fallbackRefresh?: string): TokenSet {
  if (!data.access_token) {
    throw new Error(
      data.error_description || data.error || "Token response missing access_token",
    );
  }
  const refresh = data.refresh_token || fallbackRefresh;
  if (!refresh) {
    throw new Error("Token response missing refresh_token");
  }
  const expiresIn = Number(data.expires_in) || 900;
  return {
    accessToken: data.access_token,
    refreshToken: refresh,
    expiresAtMs: Date.now() + expiresIn * 1000,
  };
}

function parseTokenBody(res: HttpJsonResult, what: string): OAuthTokenResponse {
  let data: OAuthTokenResponse;
  try {
    data = JSON.parse(res.body) as OAuthTokenResponse;
  } catch {
    throw new Error(`${what} failed (bad response from Parascene)`);
  }
  if (res.status >= 400 || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `${what} failed (HTTP ${res.status})`,
    );
  }
  return data;
}

export class ParasceneSdk {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  private getAccessToken: () => Promise<string | null>;
  private onRefreshNeeded?: () => Promise<TokenSet | null>;

  constructor(config: ParasceneSdkConfig) {
    this.baseUrl = normalizeBase(config.baseUrl);
    this.apiBaseUrl = normalizeBase(config.apiBaseUrl ?? config.baseUrl);
    this.clientId = config.clientId;
    this.redirectUri = config.redirectUri;
    this.getAccessToken = config.getAccessToken;
    this.onRefreshNeeded = config.onRefreshNeeded;
  }

  /** Open this URL in the system browser — real Parascene consent. */
  buildAuthorizeUrl(opts: {
    state: string;
    codeChallenge: string;
  }): string {
    const u = new URL(`${this.baseUrl}/oauth/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.clientId);
    u.searchParams.set("redirect_uri", this.redirectUri);
    u.searchParams.set("state", opts.state);
    u.searchParams.set("scope", "openid profile");
    u.searchParams.set("code_challenge_method", "S256");
    u.searchParams.set("code_challenge", opts.codeChallenge);
    return u.toString();
  }

  /**
   * Public-client token exchange (PKCE only — no developer API key).
   * Uses Rust HTTP so the WebView is not required for the call.
   */
  async exchangeAuthorizationCode(opts: {
    code: string;
    codeVerifier: string;
  }): Promise<TokenSet> {
    const res = await postJson(`${this.baseUrl}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: this.clientId,
      code: opts.code,
      redirect_uri: this.redirectUri,
      code_verifier: opts.codeVerifier,
    });
    return tokenSetFromResponse(parseTokenBody(res, "Token exchange"));
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const res = await postJson(`${this.baseUrl}/oauth/token`, {
      grant_type: "refresh_token",
      client_id: this.clientId,
      refresh_token: refreshToken,
    });
    return tokenSetFromResponse(
      parseTokenBody(res, "Refresh"),
      refreshToken,
    );
  }

  async getUserInfo(): Promise<ParasceneUserInfo> {
    const token = await this.requireAccessToken();
    const res = await getBearer(`${this.baseUrl}/oauth/userinfo`, token);
    if (res.status >= 400) {
      throw new Error(`userinfo failed (${res.status})`);
    }
    const raw = JSON.parse(res.body) as ParasceneUserInfo;
    return {
      ...raw,
      picture: absolutizeAssetUrl(raw.picture, this.baseUrl),
    };
  }

  /**
   * Signed-in creations catalog (`GET /api/create/images`).
   * Same list the web Creations page uses.
   */
  async listMyCreations(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<ListCreateImagesResult> {
    const token = await this.requireAccessToken();
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
    const offset = Math.max(0, opts?.offset ?? 0);
    const url = new URL(`${this.apiBaseUrl}/api/create/images`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await getBearer(url.toString(), token);
    if (res.status >= 400) {
      let message = `list creations failed (${res.status})`;
      try {
        const err = JSON.parse(res.body) as { error?: string; message?: string };
        message = err.message || err.error || message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }
    const data = JSON.parse(res.body) as {
      images?: RemoteCreateImage[];
      has_more?: boolean;
    };
    return {
      images: Array.isArray(data.images) ? data.images : [],
      hasMore: data.has_more === true,
    };
  }

  private async requireAccessToken(): Promise<string> {
    let token = await this.getAccessToken();
    const needsRefresh =
      !token || (Boolean(token) && isAccessTokenExpiredOrNear(token));
    if (needsRefresh && this.onRefreshNeeded) {
      const next = await this.onRefreshNeeded();
      token = next?.accessToken ?? token;
    }
    if (!token) {
      throw new Error("Not signed in");
    }
    return token;
  }
}

/** JWT `exp` check so we refresh before Parascene returns Unauthorized. */
export function isAccessTokenExpiredOrNear(
  token: string,
  skewMs = 60_000,
): boolean {
  try {
    const part = token.split(".")[1];
    if (!part) return true;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== "number") return false;
    return payload.exp * 1000 <= Date.now() + skewMs;
  } catch {
    return true;
  }
}

export function createParasceneSdk(config: ParasceneSdkConfig): ParasceneSdk {
  return new ParasceneSdk(config);
}

export function absolutizeAssetUrl(
  value: string | undefined,
  origin: string,
): string | undefined {
  if (!value) return value;
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  const base = normalizeBase(origin);
  if (v.startsWith("/")) return base + v;
  return v;
}
