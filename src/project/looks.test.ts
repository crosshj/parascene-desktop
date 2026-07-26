import { describe, expect, it } from "vitest";
import {
  enabledLookLabels,
  firstEnabledLookId,
  isLookEnabled,
  normalizeProjectLooks,
} from "./looks";
import {
  createStoredProject,
  setStoredProjectLookEnabled,
  storedProjectToUi,
} from "./projectStore";

describe("project looks", () => {
  it("normalizes missing and unknown looks; keeps one enabled", () => {
    expect(normalizeProjectLooks(undefined)).toEqual({});
    expect(
      normalizeProjectLooks({
        tv: { enabled: true },
        afterglow: { enabled: true },
        fake: { enabled: true },
      }),
    ).toEqual({
      tv: { enabled: true },
      afterglow: { enabled: false },
    });
  });

  it("toggles Looks exclusively on the stored project", () => {
    let project = createStoredProject("Looks demo");
    expect(isLookEnabled(storedProjectToUi(project).looks, "tv")).toBe(false);

    project = setStoredProjectLookEnabled(project, "tv", true);
    expect(isLookEnabled(storedProjectToUi(project).looks, "tv")).toBe(true);
    expect(enabledLookLabels(project.looks)).toEqual(["TV"]);
    expect(firstEnabledLookId(project.looks)).toBe("tv");

    project = setStoredProjectLookEnabled(project, "afterglow", true);
    expect(enabledLookLabels(project.looks)).toEqual(["Afterglow"]);
    expect(firstEnabledLookId(project.looks)).toBe("afterglow");
    expect(isLookEnabled(project.looks, "tv")).toBe(false);

    project = setStoredProjectLookEnabled(project, "broadcast", true);
    expect(enabledLookLabels(project.looks)).toEqual(["Broadcast"]);
    expect(isLookEnabled(project.looks, "afterglow")).toBe(false);

    project = setStoredProjectLookEnabled(project, "broadcast", false);
    expect(enabledLookLabels(project.looks)).toEqual([]);
    expect(firstEnabledLookId(project.looks)).toBe(null);
  });
});