import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createParasceneSdk,
  absolutizeAssetUrl,
  isAccessTokenExpiredOrNear,
} from "./parascene";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("ParasceneSdk", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("builds Parascene authorize URL", () => {
    const sdk = createParasceneSdk({
      baseUrl: "https://www.parascene.com",
      clientId: "c7826d84-92b2-42b5-92db-473662b51a77",
      redirectUri: "http://127.0.0.1:17423/oauth/callback",
      getAccessToken: async () => null,
    });
    const url = sdk.buildAuthorizeUrl({
      state: "abc",
      codeChallenge: "chal",
    });
    expect(url.startsWith("https://www.parascene.com/oauth/authorize?")).toBe(
      true,
    );
    expect(url).toContain("client_id=c7826d84-92b2-42b5-92db-473662b51a77");
    expect(url).toContain(
      encodeURIComponent("http://127.0.0.1:17423/oauth/callback"),
    );
  });

  it("exchanges auth code via Rust HTTP to Parascene /oauth/token", async () => {
    invoke.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 900,
      }),
    });

    const sdk = createParasceneSdk({
      baseUrl: "https://www.parascene.com",
      clientId: "app",
      redirectUri: "http://127.0.0.1:17423/oauth/callback",
      getAccessToken: async () => null,
    });
    const tokens = await sdk.exchangeAuthorizationCode({
      code: "the-code",
      codeVerifier: "verifier",
    });
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAtMs).toBeGreaterThan(Date.now());
    expect(invoke).toHaveBeenCalledWith(
      "http_post_json",
      expect.objectContaining({
        url: "https://www.parascene.com/oauth/token",
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: "app",
          code: "the-code",
          redirect_uri: "http://127.0.0.1:17423/oauth/callback",
          code_verifier: "verifier",
        }),
      }),
    );
  });

  it("absolutizes root-relative picture URLs", () => {
    expect(
      absolutizeAssetUrl("/avatars/a.png", "https://www.parascene.com"),
    ).toBe("https://www.parascene.com/avatars/a.png");
  });

  it("detects expired access JWTs", () => {
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 10 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(isAccessTokenExpiredOrNear(`hdr.${payload}.sig`)).toBe(true);
  });

  it("lists creations from the API origin with the access token", async () => {
    invoke.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        images: [{ id: 1, title: "One", media_type: "image" }],
        has_more: false,
      }),
    });

    const sdk = createParasceneSdk({
      baseUrl: "https://www.parascene.com",
      apiBaseUrl: "https://api.parascene.com",
      clientId: "app",
      redirectUri: "http://127.0.0.1:17423/oauth/callback",
      getAccessToken: async () => "access-jwt",
    });
    const page = await sdk.listMyCreations({ limit: 50, offset: 0 });
    expect(page.images).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(invoke).toHaveBeenCalledWith(
      "http_get_bearer",
      expect.objectContaining({
        url: "https://api.parascene.com/api/create/images?limit=50&offset=0",
        bearer: "access-jwt",
      }),
    );
  });
});

