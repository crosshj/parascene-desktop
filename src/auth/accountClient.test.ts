import { describe, expect, it, beforeEach } from "vitest";
import { applyHydrate, snapshotLocalStorage } from "./accountClient";

describe("account localStorage compact", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("snapshots every key", () => {
    window.localStorage.setItem("parascene.projects.v1", "[]");
    window.localStorage.setItem("parascene.lab.foo", "bar");
    expect(snapshotLocalStorage()).toEqual({
      "parascene.projects.v1": "[]",
      "parascene.lab.foo": "bar",
    });
  });

  it("flushes writers before snapshot", () => {
    window.addEventListener("parascene:account-flush", () => {
      window.localStorage.setItem("parascene.lab.draft", "from-flush");
    });
    expect(snapshotLocalStorage()["parascene.lab.draft"]).toBe("from-flush");
  });

  it("does not clear when hydrate is not present (legacy)", () => {
    window.localStorage.setItem("parascene.projects.v1", "[1]");
    applyHydrate({ localStorage: {}, present: false });
    expect(window.localStorage.getItem("parascene.projects.v1")).toBe("[1]");
  });

  it("replaces all keys when hydrate is present", () => {
    window.localStorage.setItem("stale", "x");
    applyHydrate({
      present: true,
      localStorage: { "parascene.lab.foo": "bar" },
    });
    expect(window.localStorage.getItem("stale")).toBeNull();
    expect(window.localStorage.getItem("parascene.lab.foo")).toBe("bar");
  });

  it("notifies settings listeners after hydrate", () => {
    const seen: string[] = [];
    const onQuality = () => seen.push("quality");
    const onHydrated = () => seen.push("hydrated");
    window.addEventListener("parascene:preview-quality-changed", onQuality);
    window.addEventListener("parascene:account-hydrated", onHydrated);
    applyHydrate({
      present: true,
      localStorage: { "parascene.previewQuality": "high" },
    });
    window.removeEventListener("parascene:preview-quality-changed", onQuality);
    window.removeEventListener("parascene:account-hydrated", onHydrated);
    expect(seen).toEqual(["quality", "hydrated"]);
    expect(window.localStorage.getItem("parascene.previewQuality")).toBe("high");
  });
});
