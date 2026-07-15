/** Public Parascene OAuth app id — safe to ship in the binary. */
export const PARASCENE_CLIENT_ID =
  "c7826d84-92b2-42b5-92db-473662b51a77";

export const PARASCENE_BASE_URL_DEFAULT = "https://www.parascene.com";

/** Origin for `/api/...` product routes (OAuth still uses site base URL). */
export const PARASCENE_API_BASE_URL_DEFAULT = "https://api.parascene.com";

/**
 * Loopback redirect registered on the Parascene app.
 * Must match Connections → Redirect URLs exactly.
 */
export const PARASCENE_OAUTH_REDIRECT_URI =
  "http://127.0.0.1:17423/oauth/callback";

export const PARASCENE_OAUTH_LOOPBACK_PORT = 17423;
