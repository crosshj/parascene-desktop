import { describe, expect, it } from "vitest";
import {
  isSessionReauthError,
  isTransientNetworkError,
  mapCatalogSyncError,
  mapEnsureAccessTokenError,
} from "./errors";

describe("auth error helpers", () => {
  it("detects session reauth cases including folder rejection copy", () => {
    expect(
      isSessionReauthError(
        "Your Parascene session expired. Reconnect in the browser, then retry Sync.",
      ),
    ).toBe(true);
    expect(
      isSessionReauthError(
        "Session expired — reconnect to Parascene (refresh token invalidated)",
      ),
    ).toBe(true);
    expect(isSessionReauthError("Not signed in")).toBe(true);
    expect(
      isSessionReauthError(
        "Parascene rejected the session (Unauthorized). Try logging out and back in.",
      ),
    ).toBe(true);
    expect(isSessionReauthError("Couldn't reach Parascene")).toBe(false);
  });

  it("detects transient network failures", () => {
    expect(
      isTransientNetworkError(
        "Request failed: error sending request for url (https://api.parascene.com/api/create/images)",
      ),
    ).toBe(true);
    expect(
      isTransientNetworkError(
        "Couldn't reach Parascene (https://api.parascene.com/x). Check your network and try again.",
      ),
    ).toBe(true);
    expect(isTransientNetworkError("list creations failed (500)")).toBe(false);
  });

  it("maps catalog sync errors to Sync-friendly copy", () => {
    expect(
      mapCatalogSyncError(new Error("Unauthorized")).message,
    ).toMatch(/session expired/i);
    expect(
      mapCatalogSyncError(
        new Error(
          "Request failed: error sending request for url (https://api.parascene.com/api/create/images?limit=50&offset=0)",
        ),
      ).message,
    ).toMatch(/couldn't reach parascene/i);
  });

  it("maps ensure-token failures without treating all errors as reauth", () => {
    expect(
      mapEnsureAccessTokenError(
        new Error("Session expired — reconnect to Parascene"),
      ).message,
    ).toMatch(/session expired/i);
    expect(
      mapEnsureAccessTokenError(new Error("Token refresh timed out")).message,
    ).toMatch(/check your network/i);
  });
});
