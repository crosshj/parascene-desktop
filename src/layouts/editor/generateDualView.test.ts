import { describe, expect, it } from "vitest";
import type { TimelineClip } from "../../project/types";
import {
  defaultGenerateDualView,
  resolveGenerateDualPhase,
  selectionSupportsGenerateDualView,
  shouldPreserveGenerateDualView,
} from "./generateDualView";

function placeholder(partial?: Partial<TimelineClip>): TimelineClip {
  return {
    id: "ph",
    label: "Generate",
    lane: "video",
    kind: "video",
    startSec: 0,
    endSec: 4,
    isAddAssetPlaceholder: true,
    ...partial,
  };
}

describe("generateDualView", () => {
  it("defaults Form for pre-gen/error and Result for running/done", () => {
    expect(defaultGenerateDualView("pre_gen")).toBe("form");
    expect(defaultGenerateDualView("error")).toBe("form");
    expect(defaultGenerateDualView("running")).toBe("result");
    expect(defaultGenerateDualView("done")).toBe("result");
  });

  it("keeps Result | Form sticky across finished generation hosts", () => {
    expect(
      shouldPreserveGenerateDualView({
        prevHostKey: "gen:a",
        nextHostKey: "gen:b",
      }),
    ).toBe(true);
    expect(
      shouldPreserveGenerateDualView({
        prevHostKey: "gen:a",
        nextHostKey: "ph:x",
      }),
    ).toBe(false);
    expect(
      shouldPreserveGenerateDualView({
        prevHostKey: "ph:x",
        nextHostKey: "gen:a",
      }),
    ).toBe(false);
  });

  it("detects placeholder phases", () => {
    expect(
      resolveGenerateDualPhase({ placeholder: placeholder() }),
    ).toBe("pre_gen");
    expect(
      resolveGenerateDualPhase({
        placeholder: placeholder(),
        session: {
          clipId: "ph",
          phase: "running",
          startedAtMs: 1,
          expectedMs: 1000,
          steps: [],
          progressNote: "…",
          errorMessage: null,
        },
      }),
    ).toBe("running");
    expect(
      resolveGenerateDualPhase({
        placeholder: placeholder({
          addAssetDraft: { lastError: "boom" },
        }),
      }),
    ).toBe("error");
  });

  it("treats finished generation as done", () => {
    expect(
      resolveGenerateDualPhase({
        generation: {
          prompt: "x",
          generatedAt: "2026-01-01T00:00:00.000Z",
          creationId: "c1",
          mode: "start_frame",
          model: "ltx_i2v",
        },
      }),
    ).toBe("done");
  });

  it("supports dual view for placeholders and provenance", () => {
    expect(
      selectionSupportsGenerateDualView({
        isPlaceholder: true,
        generation: null,
      }),
    ).toBe(true);
    expect(
      selectionSupportsGenerateDualView({
        isPlaceholder: false,
        generation: {
          prompt: "x",
          generatedAt: "2026-01-01T00:00:00.000Z",
          creationId: "c1",
          mode: "start_frame",
          model: "ltx_i2v",
        },
      }),
    ).toBe(true);
    expect(
      selectionSupportsGenerateDualView({
        isPlaceholder: false,
        generation: null,
      }),
    ).toBe(false);
  });
});
