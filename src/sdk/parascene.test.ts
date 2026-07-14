import { describe, expect, it, vi, beforeEach } from "vitest";
import { createParasceneSdk, absolutizeAssetUrl } from "./parascene";

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
});
