/** In-memory ring buffer for editor / publisher diagnosis (UI diagnostics Copy). */

export type UiOpTraceEvent = {
  t: string;
  type: string;
  reason?: string;
  clipId?: string;
  kind?: string;
  count?: number;
  /** Optional free-form ids (e.g. media download set). */
  ids?: string;
};

const MAX_EVENTS = 100;
const events: UiOpTraceEvent[] = [];

export function recordUiOpTrace(
  event: Omit<UiOpTraceEvent, "t"> & { t?: string },
): void {
  events.push({
    ...event,
    t: event.t ?? new Date().toISOString(),
  });
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
}

export function getUiOpTrace(): readonly UiOpTraceEvent[] {
  return events;
}

export function clearUiOpTrace(): void {
  events.length = 0;
}

export function formatUiOpTrace(
  rows: readonly UiOpTraceEvent[] = events,
): string {
  if (rows.length === 0) return "  (empty)";
  return rows
    .map((row) => {
      const parts = [`${row.t} ${row.type}`];
      if (row.clipId) parts.push(`clip=${row.clipId}`);
      if (row.kind) parts.push(`kind=${row.kind}`);
      if (row.count != null) parts.push(`count=${row.count}`);
      if (row.ids) parts.push(`ids=${row.ids}`);
      if (row.reason) parts.push(`reason=${row.reason}`);
      return `  ${parts.join(" ")}`;
    })
    .join("\n");
}

/** @deprecated Use recordUiOpTrace — kept for call-site migration. */
export const recordStagedClipDragTrace = recordUiOpTrace;
/** @deprecated Use getUiOpTrace */
export const getStagedClipDragTrace = getUiOpTrace;
/** @deprecated Use clearUiOpTrace */
export const clearStagedClipDragTrace = clearUiOpTrace;
/** @deprecated Use formatUiOpTrace */
export const formatStagedClipDragTrace = formatUiOpTrace;
export type StagedClipDragTraceEvent = UiOpTraceEvent;
