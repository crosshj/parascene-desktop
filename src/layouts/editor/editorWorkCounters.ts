/**
 * Temporary development counters for idle-loop and concurrency checks.
 * Not packaged benchmarks — tests and a glance at logs use these.
 */

export type EditorWorkCounters = {
  catalogLoads: number;
  reconciliationCalls: number;
  libraryListeners: number;
  activeGeneration: number;
  activePreviewBakes: number;
  framePeeksStarted: number;
};

const counters: EditorWorkCounters = {
  catalogLoads: 0,
  reconciliationCalls: 0,
  libraryListeners: 0,
  activeGeneration: 0,
  activePreviewBakes: 0,
  framePeeksStarted: 0,
};

export function bumpEditorWorkCounter(
  key: keyof Pick<
    EditorWorkCounters,
    "catalogLoads" | "reconciliationCalls" | "framePeeksStarted"
  >,
  delta = 1,
): number {
  counters[key] += delta;
  return counters[key];
}

export function setEditorWorkGauge(
  key: keyof Pick<
    EditorWorkCounters,
    "libraryListeners" | "activeGeneration" | "activePreviewBakes"
  >,
  value: number,
): number {
  counters[key] = Math.max(0, value);
  return counters[key];
}

export function bumpEditorWorkGauge(
  key: keyof Pick<
    EditorWorkCounters,
    "libraryListeners" | "activeGeneration" | "activePreviewBakes"
  >,
  delta: number,
): number {
  return setEditorWorkGauge(key, counters[key] + delta);
}

export function getEditorWorkCounters(): Readonly<EditorWorkCounters> {
  return { ...counters };
}

export function resetEditorWorkCounters(): void {
  counters.catalogLoads = 0;
  counters.reconciliationCalls = 0;
  counters.libraryListeners = 0;
  counters.activeGeneration = 0;
  counters.activePreviewBakes = 0;
  counters.framePeeksStarted = 0;
}
