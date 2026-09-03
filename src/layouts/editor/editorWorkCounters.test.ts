import { describe, expect, it } from "vitest";
import {
  bumpEditorWorkCounter,
  bumpEditorWorkGauge,
  getEditorWorkCounters,
  resetEditorWorkCounters,
  setEditorWorkGauge,
} from "./editorWorkCounters";

describe("editorWorkCounters", () => {
  it("tracks bumps and gauges independently", () => {
    resetEditorWorkCounters();
    expect(getEditorWorkCounters().catalogLoads).toBe(0);
    bumpEditorWorkCounter("catalogLoads");
    bumpEditorWorkCounter("catalogLoads", 2);
    bumpEditorWorkGauge("libraryListeners", 1);
    setEditorWorkGauge("activeGeneration", 3);
    bumpEditorWorkGauge("activeGeneration", -1);
    expect(getEditorWorkCounters()).toEqual({
      catalogLoads: 3,
      reconciliationCalls: 0,
      libraryListeners: 1,
      activeGeneration: 2,
      activePreviewBakes: 0,
      framePeeksStarted: 0,
    });
    resetEditorWorkCounters();
    expect(getEditorWorkCounters().catalogLoads).toBe(0);
  });
});
