/** In-memory ring buffer for staged-clip drag → timeline drop diagnosis. */

export type StagedClipDragTraceEvent = {
  t: string;
  type: string;
  pointerType?: string;
  pointerId?: number | null;
  x?: number;
  y?: number;
  lastMoveX?: number;
  lastMoveY?: number;
  overTracks?: boolean;
  scrollRect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  drop?: boolean;
  reason?: string;
  clipId?: string;
  kind?: string;
};

const MAX_EVENTS = 40;
const events: StagedClipDragTraceEvent[] = [];

export function recordStagedClipDragTrace(
  event: Omit<StagedClipDragTraceEvent, "t"> & { t?: string },
): void {
  events.push({
    ...event,
    t: event.t ?? new Date().toISOString(),
  });
  while (events.length > MAX_EVENTS) {
    events.shift();
  }
}

export function getStagedClipDragTrace(): readonly StagedClipDragTraceEvent[] {
  return events;
}

export function clearStagedClipDragTrace(): void {
  events.length = 0;
}

export function formatStagedClipDragTrace(
  rows: readonly StagedClipDragTraceEvent[] = events,
): string {
  if (rows.length === 0) return "  (empty)";
  return rows
    .map((row) => {
      const parts = [`${row.t} ${row.type}`];
      if (row.pointerType) parts.push(`ptr=${row.pointerType}`);
      if (row.pointerId != null) parts.push(`id=${row.pointerId}`);
      if (row.x != null && row.y != null) {
        parts.push(`xy=${Math.round(row.x)},${Math.round(row.y)}`);
      }
      if (row.lastMoveX != null && row.lastMoveY != null) {
        parts.push(
          `last=${Math.round(row.lastMoveX)},${Math.round(row.lastMoveY)}`,
        );
      }
      if (row.overTracks != null) parts.push(`overTracks=${row.overTracks}`);
      if (row.drop != null) parts.push(`drop=${row.drop}`);
      if (row.scrollRect) {
        const r = row.scrollRect;
        parts.push(
          `scroll=${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`,
        );
      }
      if (row.clipId) parts.push(`clip=${row.clipId}`);
      if (row.kind) parts.push(`kind=${row.kind}`);
      if (row.reason) parts.push(`reason=${row.reason}`);
      return `  ${parts.join(" ")}`;
    })
    .join("\n");
}

export function scrollRectSnapshot(
  el: Element | null | undefined,
): StagedClipDragTraceEvent["scrollRect"] | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}
