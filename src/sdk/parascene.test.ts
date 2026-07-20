import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createParasceneSdk,
  absolutizeAssetUrl,
  deriveFitThumbnailUrl,
  isAccessTokenExpiredOrNear,
  LibraryFoldersConflictError,
  LibraryFoldersUnavailableError,
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

  it("derives fit thumbnail urls when the API omits fit_thumbnail_url", () => {
    expect(
      deriveFitThumbnailUrl(
        "https://www.parascene.com/api/images/created/x.png?creation_id=18843&variant=thumbnail",
      ),
    ).toBe(
      "https://www.parascene.com/api/images/created/x.png?creation_id=18843&variant=fit",
    );
    expect(deriveFitThumbnailUrl("https://cdn.example/t.jpg")).toBe(
      "https://cdn.example/t.jpg?variant=fit",
    );
    expect(deriveFitThumbnailUrl(null, "https://cdn.example/v.mp4")).toBeNull();
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

  it("retries list creations once after a transient transport error", async () => {
    invoke
      .mockRejectedValueOnce(
        new Error(
          "Request failed: error sending request for url (https://api.parascene.com/api/create/images?limit=50&offset=0)",
        ),
      )
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          images: [{ id: 2, title: "Two", media_type: "image" }],
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
    expect(page.images[0]?.id).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("loads library folders from the API origin", async () => {
    invoke.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        revision: 3,
        folders: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            title: "Favorites",
            description: "",
            created_at: "2026-07-18T20:00:00.000Z",
            updated_at: "2026-07-18T20:05:00.000Z",
            creation_ids: [101, 102],
            member_count: 2,
          },
        ],
      }),
    });

    const sdk = createParasceneSdk({
      baseUrl: "https://www.parascene.com",
      apiBaseUrl: "https://api.parascene.com",
      clientId: "app",
      redirectUri: "http://127.0.0.1:17423/oauth/callback",
      getAccessToken: async () => "access-jwt",
    });
    const snapshot = await sdk.getLibraryFolders();
    expect(snapshot.revision).toBe(3);
    expect(snapshot.folders).toHaveLength(1);
    expect(snapshot.folders[0]?.creation_ids).toEqual([101, 102]);
    expect(invoke).toHaveBeenCalledWith(
      "http_get_bearer",
      expect.objectContaining({
        url: "https://api.parascene.com/api/library/folders",
        bearer: "access-jwt",
      }),
    );
  });

  it("mutates library folders and surfaces 409 conflicts", async () => {
    const sdk = createParasceneSdk({
      baseUrl: "https://www.parascene.com",
      apiBaseUrl: "https://api.parascene.com",
      clientId: "app",
      redirectUri: "http://127.0.0.1:17423/oauth/callback",
      getAccessToken: async () => "access-jwt",
    });

    invoke.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        revision: 4,
        folders: [],
      }),
    });
    const ok = await sdk.mutateLibraryFolders({
      baseRevision: 3,
      operations: [
        {
          op: "create",
          id: "22222222-2222-4222-8222-222222222222",
          title: "B-roll",
          creation_ids: [103],
        },
      ],
    });
    expect(ok.revision).toBe(4);
    expect(invoke).toHaveBeenCalledWith(
      "http_post_bearer",
      expect.objectContaining({
        url: "https://api.parascene.com/api/library/folders/mutate",
        bearer: "access-jwt",
        body: JSON.stringify({
          base_revision: 3,
          operations: [
            {
              op: "create",
              id: "22222222-2222-4222-8222-222222222222",
              title: "B-roll",
              creation_ids: [103],
            },
          ],
        }),
      }),
    );

    invoke.mockResolvedValueOnce({
      status: 409,
      body: JSON.stringify({
        error: "conflict",
        message: "base_revision is stale; pull and retry",
        revision: 5,
        folders: [{ id: "a", title: "X", creation_ids: [] }],
      }),
    });
    await expect(
      sdk.mutateLibraryFolders({
        baseRevision: 3,
        operations: [{ op: "delete", id: "22222222-2222-4222-8222-222222222222" }],
      }),
    ).rejects.toBeInstanceOf(LibraryFoldersConflictError);

    invoke.mockResolvedValueOnce({
      status: 501,
      body: JSON.stringify({ error: "Library folders are not available" }),
    });
    await expect(sdk.getLibraryFolders()).rejects.toBeInstanceOf(
      LibraryFoldersUnavailableError,
    );
  });
});

