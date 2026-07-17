import { useEffect, useMemo, useState, type RefObject } from "react";
import { creationPackHeight } from "./aspectRatio";
import type { Creation } from "./types";

/** Match Parascene explore/create dense board (~6px gutters). */
export const MASONRY_GAP_PX = 6;

export type MasonryLayout = {
  columnCount: number;
  columnWidth: number;
  /** False until the scroller has been measured at least once. */
  ready: boolean;
};

/**
 * Shortest-column pack. Column membership is sticky per id so scroll/downloads
 * don't reshuffle cards between columns (avoids jumpy remounts).
 */
export function packByAspectStable(
  items: Creation[],
  layout: MasonryLayout,
  assignment: Map<string, number>,
): Creation[][] {
  const cols = Math.max(1, layout.columnCount);
  const packed: Creation[][] = Array.from({ length: cols }, () => []);
  const heights = Array.from({ length: cols }, () => 0);
  const gutter =
    layout.columnWidth > 0 ? MASONRY_GAP_PX / layout.columnWidth : 0;

  const living = new Set(items.map((item) => item.id));
  for (const id of [...assignment.keys()]) {
    if (!living.has(id) || (assignment.get(id) ?? 0) >= cols) {
      assignment.delete(id);
    }
  }

  for (const item of items) {
    let col = assignment.get(item.id);
    if (col === undefined || col >= cols) {
      col = 0;
      for (let i = 1; i < cols; i++) {
        if (heights[i] < heights[col]) col = i;
      }
      assignment.set(item.id, col);
    }
    packed[col].push(item);
    heights[col] += creationPackHeight(item) + gutter;
  }
  return packed;
}

/** Stateless pack (tests / one-shot). */
export function packByAspect(
  items: Creation[],
  layout: MasonryLayout,
): Creation[][] {
  return packByAspectStable(items, layout, new Map());
}

/** Aim for about this card width; wider boards gain columns instead of stretching. */
export const TARGET_COLUMN_WIDTH_PX = 220;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 14;

/** Column count from container width — scales past the old hard cap of 6. */
export function columnCountForWidth(width: number): number {
  if (width <= 0) return MIN_COLUMNS;
  const count = Math.floor(
    (width + MASONRY_GAP_PX) / (TARGET_COLUMN_WIDTH_PX + MASONRY_GAP_PX),
  );
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, count));
}

export function useMasonryLayout(
  containerRef: RefObject<HTMLElement | null>,
): MasonryLayout {
  const [layout, setLayout] = useState<MasonryLayout>({
    columnCount: 5,
    columnWidth: 240,
    ready: false,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const columnCount = columnCountForWidth(width);
      const columnWidth = Math.max(
        1,
        (width - MASONRY_GAP_PX * (columnCount - 1)) / columnCount,
      );
      setLayout((prev) => {
        if (
          prev.ready &&
          prev.columnCount === columnCount &&
          Math.abs(prev.columnWidth - columnWidth) < 2
        ) {
          return prev;
        }
        return { columnCount, columnWidth, ready: true };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef]);

  return layout;
}

export function usePackedColumns(
  items: Creation[],
  layout: MasonryLayout,
): Creation[][] {
  const [packState, setPackState] = useState(() => ({
    columnCount: layout.columnCount,
    assignment: new Map<string, number>(),
  }));
  if (packState.columnCount !== layout.columnCount) {
    setPackState({
      columnCount: layout.columnCount,
      assignment: new Map(),
    });
  }

  const aspectKey = items
    .map(
      (c) =>
        `${c.id}:${c.aspectRatio ?? ""}:${c.width ?? ""}:${c.height ?? ""}`,
    )
    .join("|");

  return useMemo(
    () => packByAspectStable(items, layout, packState.assignment),
    // assignment map is mutated in place; columnCount/items/aspect drive recompute
    [items, layout, packState.assignment, aspectKey],
  );
}
