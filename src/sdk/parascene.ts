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
  /** Native-aspect alt thumb; may 404 until fit repair / new upload. */
  fit_thumbnail_url?: string | null;
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

export type RepairBatchResult = {
  updated: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  updated_count: number;
  skipped_count: number;
  scanned?: number;
  offset?: number;
  next_offset?: number;
  exhausted?: boolean;
};

type HttpJsonResult = {
  status: number;
  body: string;
  retryAfterSec?: number | null;
  retry_after_sec?: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(res: HttpJsonResult, attempt: number): number {
  const fromHeader = res.retry_after_sec ?? res.retryAfterSec;
  if (typeof fromHeader === "number" && fromHeader > 0) {
    return Math.min(120_000, Math.max(1_000, fromHeader * 1000));
  }
  return Math.min(60_000, 2000 * 2 ** attempt);
}

function isRateLimited(res: HttpJsonResult): boolean {
  if (res.status === 429 || res.status === 503) return true;
  try {
    const err = JSON.parse(res.body) as { message?: string; error?: string };
    const msg = `${err.message || ""} ${err.error || ""}`.toLowerCase();
    return msg.includes("rate limit");
  } catch {
    return false;
  }
}

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

async function postBearer(
  url: string,
  payload: unknown,
  bearer: string,
): Promise<HttpJsonResult> {
  return invoke<HttpJsonResult>("http_post_bearer", {
    url,
    body: JSON.stringify(payload),
    bearer,
  });
}

/** POST with bearer; wait and retry on 429/503 using Retry-After when present. */
async function postBearerResilient(
  url: string,
  payload: unknown,
  bearer: string,
  opts?: { maxAttempts?: number; onWait?: (ms: number) => void },
): Promise<HttpJsonResult> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  let last: HttpJsonResult = { status: 0, body: "" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await postBearer(url, payload, bearer);
    if (!isRateLimited(last)) return last;
    const wait = retryAfterMs(last, attempt);
    opts?.onWait?.(wait);
    await sleep(wait);
  }
  return last;
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

  /**
   * Repair `meta.args.aspect_ratio` on group creations from the first source.
   * `POST /api/create/images/repair-group-aspect`
   */
  async repairGroupAspect(opts?: {
    ids?: Array<number | string>;
    limit?: number;
    onWait?: (ms: number) => void;
  }): Promise<RepairBatchResult> {
    return this.postRepair("/api/create/images/repair-group-aspect", opts);
  }

  /**
   * Generate native-aspect fit thumbs for non-square creations missing them.
   * `POST /api/create/images/repair-fit-thumbnails`
   */
  async repairFitThumbnails(opts?: {
    ids?: Array<number | string>;
    limit?: number;
    force?: boolean;
    offset?: number;
    onWait?: (ms: number) => void;
  }): Promise<RepairBatchResult> {
    return this.postRepair("/api/create/images/repair-fit-thumbnails", opts);
  }

  /**
   * Upload a native-aspect fit JPEG produced locally (e.g. video first frame).
   * `POST /api/create/images/:id/fit-thumbnail` with `image_base64`.
   */
  async uploadFitThumbnail(
    id: string | number,
    imageBase64: string,
    opts?: { onWait?: (ms: number) => void },
  ): Promise<{ ok: boolean; from_client?: boolean }> {
    const token = await this.requireAccessToken();
    const res = await postBearerResilient(
      `${this.apiBaseUrl}/api/create/images/${encodeURIComponent(String(id))}/fit-thumbnail`,
      {
        image_base64: imageBase64,
        content_type: "image/jpeg",
      },
      token,
      { onWait: opts?.onWait },
    );
    if (res.status >= 400) {
      let message = `upload fit thumb failed (${res.status})`;
      try {
        const err = JSON.parse(res.body) as { error?: string; message?: string };
        message = err.message || err.error || message;
      } catch {
        /* keep */
      }
      throw new Error(message);
    }
    return JSON.parse(res.body) as { ok: boolean; from_client?: boolean };
  }

  private async postRepair(
    path: string,
    opts?: {
      ids?: Array<number | string>;
      limit?: number;
      force?: boolean;
      offset?: number;
      onWait?: (ms: number) => void;
    },
  ): Promise<RepairBatchResult> {
    const token = await this.requireAccessToken();
    const body: Record<string, unknown> = {};
    if (opts?.ids && opts.ids.length > 0) body.ids = opts.ids;
    if (typeof opts?.limit === "number") body.limit = opts.limit;
    if (typeof opts?.offset === "number") body.offset = opts.offset;
    if (opts?.force === true) body.force = true;
    const res = await postBearerResilient(
      `${this.apiBaseUrl}${path}`,
      body,
      token,
      { onWait: opts?.onWait },
    );
    if (res.status >= 400) {
      let message = `repair failed (${res.status})`;
      try {
        const err = JSON.parse(res.body) as { error?: string; message?: string };
        message = err.message || err.error || message;
      } catch {
        /* keep */
      }
      throw new Error(message);
    }
    const data = JSON.parse(res.body) as RepairBatchResult & { ok?: boolean };
    return {
      updated: Array.isArray(data.updated) ? data.updated : [],
      skipped: Array.isArray(data.skipped) ? data.skipped : [],
      updated_count:
        typeof data.updated_count === "number"
          ? data.updated_count
          : Array.isArray(data.updated)
            ? data.updated.length
            : 0,
      skipped_count:
        typeof data.skipped_count === "number"
          ? data.skipped_count
          : Array.isArray(data.skipped)
            ? data.skipped.length
            : 0,
      scanned: typeof data.scanned === "number" ? data.scanned : undefined,
      offset: typeof data.offset === "number" ? data.offset : undefined,
      next_offset:
        typeof data.next_offset === "number" ? data.next_offset : undefined,
      exhausted: data.exhausted === true,
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
