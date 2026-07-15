import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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

function columnCountForWidth(width: number): number {
  if (width <= 640) return 2;
  if (width <= 860) return 3;
  if (width <= 1100) return 4;
  if (width <= 1600) return 5;
  return 6;
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
  const assignmentRef = useRef(new Map<string, number>());
  const colsRef = useRef(layout.columnCount);

  if (colsRef.current !== layout.columnCount) {
    colsRef.current = layout.columnCount;
    assignmentRef.current = new Map();
  }

  return useMemo(
    () => packByAspectStable(items, layout, assignmentRef.current),
    // assignment map is mutated in place; columnCount/items/aspect drive recompute
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      items,
      layout.columnCount,
      layout.columnWidth,
      // Re-pack heights if aspect mix changes, without clearing sticky columns.
      items.map((c) => `${c.id}:${c.aspectRatio ?? ""}:${c.width ?? ""}:${c.height ?? ""}`).join("|"),
    ],
  );
}
