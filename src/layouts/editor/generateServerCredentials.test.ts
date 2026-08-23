import { describe, expect, it } from "vitest";
import {
  firstVisibleGenerateServer,
  isGenerateServerCapVisible,
  libraryServerFormReady,
  resetGenerateServerCredentialCachesForTests,
  serverChoiceDescription,
  serverNeedsCredentials,
  settledEnabledGenerateServerIds,
} from "./generateServerCredentials";

describe("generateServerCredentials", () => {
  const noCreds = { blueConfigured: false, replicateReady: false };
  const allCreds = { blueConfigured: true, replicateReady: true };
  const loading = { blueConfigured: null, replicateReady: null };

  it("hides BYO servers until credentials are confirmed", () => {
    expect(
      isGenerateServerCapVisible(
        { server: "replicate", status: "wired" },
        noCreds,
      ),
    ).toBe(false);
    expect(
      isGenerateServerCapVisible(
        { server: "blue_direct", status: "wired" },
        noCreds,
      ),
    ).toBe(false);
    expect(
      isGenerateServerCapVisible(
        { server: "replicate", status: "coming_soon" },
        noCreds,
      ),
    ).toBe(false);
    expect(
      isGenerateServerCapVisible(
        { server: "replicate", status: "wired" },
        allCreds,
      ),
    ).toBe(true);
    expect(
      isGenerateServerCapVisible(
        { server: "parascene_blue", status: "wired" },
        noCreds,
      ),
    ).toBe(true);
    expect(
      isGenerateServerCapVisible(
        { server: "replicate", status: "wired" },
        loading,
      ),
    ).toBe(false);
  });

  it("does not treat loading creds as missing setup", () => {
    expect(serverNeedsCredentials("replicate", loading)).toBe(false);
    expect(serverNeedsCredentials("blue_direct", loading)).toBe(false);
    expect(
      libraryServerFormReady({ server: "replicate", status: "wired" }, loading),
    ).toBe(true);
  });

  it("notes missing BYO setup in server descriptions", () => {
    expect(
      serverChoiceDescription(
        { server: "replicate", status: "wired" },
        noCreds,
        "BYO token",
      ),
    ).toContain("Replicate");
    expect(
      serverChoiceDescription(
        { server: "blue_direct", status: "wired" },
        noCreds,
        "Direct",
      ),
    ).toContain("Blue credentials");
  });

  it("picks the first wired ready server for an intent", () => {
    expect(firstVisibleGenerateServer("text_to_image", noCreds)).toBe(
      "parascene_blue",
    );
    expect(
      firstVisibleGenerateServer("text_to_image", allCreds, "replicate"),
    ).toBe("replicate");
  });
});

describe("settledEnabledGenerateServerIds", () => {
  it("caches enabled systems and ignores selection-driven remounts", () => {
    resetGenerateServerCredentialCachesForTests();
    const enabled = { blueConfigured: true, replicateReady: false };
    expect([...settledEnabledGenerateServerIds(enabled)]).toEqual([
      "parascene_blue",
      "blue_direct",
    ]);
    // Loading remount must not wipe the settled roster.
    expect([
      ...settledEnabledGenerateServerIds({
        blueConfigured: null,
        replicateReady: null,
      }),
    ]).toEqual(["parascene_blue", "blue_direct"]);
  });

  it("does not grow the roster for a historic unselected system", () => {
    resetGenerateServerCredentialCachesForTests();
    const enabled = { blueConfigured: false, replicateReady: false };
    expect([...settledEnabledGenerateServerIds(enabled)]).toEqual([
      "parascene_blue",
    ]);
  });
});
