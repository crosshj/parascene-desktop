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

/** Folder row from `GET/POST /api/library/folders` (snake_case). */
export type RemoteLibraryFolder = {
  id: string;
  title: string;
  description: string;
  created_at: string | null;
  updated_at: string | null;
  creation_ids: number[];
  member_count: number;
};

export type LibraryFoldersSnapshot = {
  revision: number;
  folders: RemoteLibraryFolder[];
};

export type LibraryFolderCreateOp = {
  op: "create";
  id: string;
  title?: string;
  description?: string;
  creation_ids?: number[];
};

export type LibraryFolderUpdateOp = {
  op: "update";
  id: string;
  title?: string;
  description?: string;
};

export type LibraryFolderDeleteOp = {
  op: "delete";
  id: string;
};

export type LibraryFolderMoveOp = {
  op: "move";
  folder_id: string | null;
  creation_ids: number[];
};

export type LibraryFolderOperation =
  | LibraryFolderCreateOp
  | LibraryFolderUpdateOp
  | LibraryFolderDeleteOp
  | LibraryFolderMoveOp;

export class LibraryFoldersConflictError extends Error {
  readonly revision: number;
  readonly folders: RemoteLibraryFolder[];

  constructor(snapshot: LibraryFoldersSnapshot, message?: string) {
    super(message || "base_revision is stale; pull and retry");
    this.name = "LibraryFoldersConflictError";
    this.revision = snapshot.revision;
    this.folders = snapshot.folders;
  }
}

export class LibraryFoldersUnavailableError extends Error {
  constructor(message = "Library folders are not available") {
    super(message);
    this.name = "LibraryFoldersUnavailableError";
  }
}

function parseLibraryFoldersSnapshot(raw: unknown): LibraryFoldersSnapshot {
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const revision = Number(data.revision);
  const foldersRaw = Array.isArray(data.folders) ? data.folders : [];
  return {
    revision: Number.isFinite(revision) && revision >= 0 ? Math.floor(revision) : 0,
    folders: foldersRaw.map((item) => {
      const folder =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      const creationIds = Array.isArray(folder.creation_ids)
        ? folder.creation_ids
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && id > 0 && Number.isInteger(id))
        : [];
      return {
        id: String(folder.id ?? ""),
        title: typeof folder.title === "string" ? folder.title : "",
        description:
          typeof folder.description === "string" ? folder.description : "",
        created_at:
          typeof folder.created_at === "string" ? folder.created_at : null,
        updated_at:
          typeof folder.updated_at === "string" ? folder.updated_at : null,
        creation_ids: creationIds,
        member_count:
          typeof folder.member_count === "number"
            ? folder.member_count
            : creationIds.length,
      };
    }),
  };
}

function libraryFoldersErrorMessage(
  res: HttpJsonResult,
  fallback: string,
): string {
  try {
    const err = JSON.parse(res.body) as { error?: string; message?: string };
    return err.message || err.error || fallback;
  } catch {
    return fallback;
  }
}

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

function isUnauthorized(res: HttpJsonResult): boolean {
  if (res.status === 401) return true;
  try {
    const err = JSON.parse(res.body) as { message?: string; error?: string };
    const msg = `${err.message || ""} ${err.error || ""}`.toLowerCase();
    return msg.includes("unauthorized");
  } catch {
    return false;
  }
}

/** POST with bearer; wait and retry on 429/503 using Retry-After when present. */
async function postBearerResilient(
  url: string,
  payload: unknown,
  bearer: string,
  opts?: {
    maxAttempts?: number;
    onWait?: (ms: number) => void;
    /** Called once on 401 to obtain a fresher bearer before retrying. */
    onUnauthorized?: () => Promise<string | null>;
  },
): Promise<HttpJsonResult> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  let token = bearer;
  let refreshed = false;
  let last: HttpJsonResult = { status: 0, body: "" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await postBearer(url, payload, token);
    if (
      isUnauthorized(last) &&
      !refreshed &&
      opts?.onUnauthorized
    ) {
      refreshed = true;
      const fresh = await opts.onUnauthorized();
      if (fresh && fresh !== token) {
        token = fresh;
        continue;
      }
    }
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
    const res = await this.getBearerAuthed(`${this.baseUrl}/oauth/userinfo`);
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
    const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
    const offset = Math.max(0, opts?.offset ?? 0);
    const url = new URL(`${this.apiBaseUrl}/api/create/images`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await this.getBearerAuthed(url.toString());
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
   * Full Library folders snapshot for the signed-in user.
   * `GET /api/library/folders`
   */
  async getLibraryFolders(): Promise<LibraryFoldersSnapshot> {
    const res = await this.getBearerAuthed(
      `${this.apiBaseUrl}/api/library/folders`,
    );
    if (res.status === 501) {
      throw new LibraryFoldersUnavailableError(
        libraryFoldersErrorMessage(res, "Library folders are not available"),
      );
    }
    if (res.status >= 400) {
      throw new Error(
        libraryFoldersErrorMessage(
          res,
          `list library folders failed (${res.status})`,
        ),
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(res.body) as unknown;
    } catch {
      throw new Error("list library folders failed (bad response)");
    }
    return parseLibraryFoldersSnapshot(raw);
  }

  /**
   * Apply a batch of folder operations when `baseRevision` matches the server.
   * `POST /api/library/folders/mutate`
   * Throws {@link LibraryFoldersConflictError} on 409.
   */
  async mutateLibraryFolders(opts: {
    baseRevision: number;
    operations: LibraryFolderOperation[];
  }): Promise<LibraryFoldersSnapshot> {
    const res = await this.postBearerAuthed(
      `${this.apiBaseUrl}/api/library/folders/mutate`,
      {
        base_revision: opts.baseRevision,
        operations: opts.operations,
      },
    );
    let raw: unknown = null;
    try {
      raw = JSON.parse(res.body) as unknown;
    } catch {
      /* keep null */
    }
    if (res.status === 409) {
      const snapshot = parseLibraryFoldersSnapshot(raw);
      throw new LibraryFoldersConflictError(
        snapshot,
        libraryFoldersErrorMessage(
          res,
          "base_revision is stale; pull and retry",
        ),
      );
    }
    if (res.status === 501) {
      throw new LibraryFoldersUnavailableError(
        libraryFoldersErrorMessage(res, "Library folders are not available"),
      );
    }
    if (res.status >= 400) {
      throw new Error(
        libraryFoldersErrorMessage(
          res,
          `mutate library folders failed (${res.status})`,
        ),
      );
    }
    if (raw == null) {
      throw new Error("mutate library folders failed (bad response)");
    }
    return parseLibraryFoldersSnapshot(raw);
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
      {
        onWait: opts?.onWait,
        onUnauthorized: () => this.forceRefreshAccessToken(),
      },
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
      {
        onWait: opts?.onWait,
        onUnauthorized: () => this.forceRefreshAccessToken(),
      },
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

  /** Force-refresh once when the server rejects a still-cached access JWT. */
  private async forceRefreshAccessToken(): Promise<string | null> {
    if (!this.onRefreshNeeded) return null;
    const next = await this.onRefreshNeeded();
    return next?.accessToken ?? null;
  }

  private async getBearerAuthed(url: string): Promise<HttpJsonResult> {
    const token = await this.requireAccessToken();
    let res = await getBearer(url, token);
    if (isUnauthorized(res)) {
      const fresh = await this.forceRefreshAccessToken();
      if (fresh && fresh !== token) {
        res = await getBearer(url, fresh);
      }
    }
    return res;
  }

  private async postBearerAuthed(
    url: string,
    payload: unknown,
  ): Promise<HttpJsonResult> {
    const token = await this.requireAccessToken();
    let res = await postBearer(url, payload, token);
    if (isUnauthorized(res)) {
      const fresh = await this.forceRefreshAccessToken();
      if (fresh && fresh !== token) {
        res = await postBearer(url, payload, fresh);
      }
    }
    return res;
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
