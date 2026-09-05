import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

import {
  applyHydrate,
  bindAndHydrate,
  snapshotLocalStorage,
} from "./accountClient";
import {
  getProjectStoreSource,
  loadStoredProjects,
  resetProjectStoreForTests,
} from "../project/projectStore";

describe("account localStorage compact", () => {
  beforeEach(() => {
    resetProjectStoreForTests();
    window.localStorage.clear();
    invoke.mockReset();
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

  it("restores compact projects when the native store is not bound", () => {
    applyHydrate({
      present: true,
      localStorage: { "parascene.projects.v1": "[]" },
    });
    expect(getProjectStoreSource()).toBe("local");
    expect(window.localStorage.getItem("parascene.projects.v1")).toBe("[]");
  });

  it("imports live FE and skips compact projects after native migrate", async () => {
    const live = {
      id: "live",
      title: "Live",
      creationIds: [] as string[],
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    invoke.mockImplementation(async (cmd: string, args?: { request?: { feJson?: string | null } }) => {
      if (cmd === "account_login") {
        return { kind: "folder", userId: "u", accountRoot: "/a", relaunch: false };
      }
      if (cmd === "projects_migrate_and_load") {
        expect(args?.request?.feJson).toContain("live");
        return { rows: [live] };
      }
      if (cmd === "account_hydrate") {
        return {
          present: true,
          localStorage: {
            "parascene.projects.v1": JSON.stringify([
              { id: "compact", title: "Stale", creationIds: [], updatedAt: "2026-01-01T00:00:00.000Z" },
            ]),
            pref: "1",
          },
        };
      }
      return undefined;
    });

    await bindAndHydrate("u", true, JSON.stringify([live]));

    expect(getProjectStoreSource()).toBe("native");
    expect(loadStoredProjects()[0].id).toBe("live");
    expect(window.localStorage.getItem("parascene.projects.v1")).toBeNull();
    expect(window.localStorage.getItem("pref")).toBe("1");
  });
});
