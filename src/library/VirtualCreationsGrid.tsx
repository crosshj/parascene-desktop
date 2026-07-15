import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { creationAspectCss, creationPackHeight } from "./aspectRatio";
import { ensureLocal } from "./catalogClient";
import { CreationCard } from "./CreationCard";
import { MASONRY_GAP_PX, useMasonryLayout } from "./CreationsMasonry";
import { canFetchLocal, creationPreviewUrl } from "./previewUrl";
import type { Creation } from "./types";
import { warmLocalPreviews } from "./warmPreviews";

/** Ask Rust for missing thumbs near the viewport (not the whole board). */
const ENSURE_AHEAD_PX = 1800;
/** Max thumb ensure requests per scroll/layout pass. */
const ENSURE_BATCH = 24;
/** Keep this much padding above/below the viewport mounted. */
const OVERSCAN_PX = 1200;
/** Start paging when less than this much scroll runway remains (min; also ≥ 4 viewports). */
const LOAD_MORE_MIN_PX = 9000;
const LOAD_MORE_VIEWPORTS = 4;

type CardLayout = {
  id: string;
  creation: Creation;
  top: number;
  left: number;
  width: number;
  height: number;
  aspectCss: string;
};

/**
 * Shortest-column pack with sticky column membership so appends and aspect
 * tweaks don't reshuffle earlier cards (avoids jumpy remounts while paging).
 * Assignment must be cleared when the list is filtered/reordered (not append-only).
 */
function layoutBoardSticky(
  items: Creation[],
  columnCount: number,
  columnWidth: number,
  assignment: Map<string, number>,
): { cards: CardLayout[]; totalHeight: number } {
  const cols = Math.max(1, columnCount);
  const tops = Array.from({ length: cols }, () => 0);
  const cards: CardLayout[] = [];

  const living = new Set(items.map((item) => item.id));
  for (const id of [...assignment.keys()]) {
    if (!living.has(id) || (assignment.get(id) ?? 0) >= cols) {
      assignment.delete(id);
    }
  }

  for (const creation of items) {
    let col = assignment.get(creation.id);
    if (col === undefined || col >= cols) {
      col = 0;
      for (let i = 1; i < cols; i++) {
        if (tops[i] < tops[col]) col = i;
      }
      assignment.set(creation.id, col);
    }
    // Creation metadata aspect only (9:16, 4:5, …). Thumbs are often square — ignore them.
    const height = Math.max(48, columnWidth * creationPackHeight(creation));
    const left = col * (columnWidth + MASONRY_GAP_PX);
    cards.push({
      id: creation.id,
      creation,
      top: tops[col],
      left,
      width: columnWidth,
      height,
      aspectCss: creationAspectCss(creation),
    });
    tops[col] += height + MASONRY_GAP_PX;
  }

  return {
    cards,
    totalHeight: Math.max(0, ...tops) || 0,
  };
}

/** True when `next` is the same prefix as `prev` plus optional new rows (infinite scroll). */
export function isAppendOnlyIdList(prev: string[], next: string[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

/**
 * Masonry board from catalog aspect ratios (SQLite).
 *
 * Positions are packed for the full loaded catalogue; only the viewport
 * (+ overscan) mounts React cards so large windows stay interactive.
 */
export function VirtualCreationsGrid({
  creations,
  selectedIds,
  dimmedIds,
  inProjectIds,
  layoutResetKey,
  onOpen,
  onToggleSelect,
  onNearEnd,
}: {
  creations: Creation[];
  selectedIds: ReadonlySet<string>;
  dimmedIds?: ReadonlySet<string>;
  inProjectIds?: ReadonlySet<string>;
  /** Change when filters change so packing/scroll reset (sticky cols would scatter otherwise). */
  layoutResetKey?: string;
  onOpen: (creation: Creation) => void;
  onToggleSelect: (creation: Creation) => void;
  onNearEnd: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const layout = useMasonryLayout(scrollerRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);
  const nearEndSent = useRef(false);
  const ensuredIds = useRef(new Set<string>());
  const assignmentRef = useRef(new Map<string, number>());
  const colsRef = useRef(0);
  const prevIdsRef = useRef<string[]>([]);
  const prevResetKeyRef = useRef(layoutResetKey);
  const rafScroll = useRef(0);

  const { cards, totalHeight } = useMemo(() => {
    if (!layout.ready) return { cards: [] as CardLayout[], totalHeight: 0 };

    const ids = creations.map((c) => c.id);
    const resetKeyChanged = prevResetKeyRef.current !== layoutResetKey;
    prevResetKeyRef.current = layoutResetKey;

    if (
      resetKeyChanged ||
      colsRef.current !== layout.columnCount ||
      !isAppendOnlyIdList(prevIdsRef.current, ids)
    ) {
      assignmentRef.current = new Map();
      colsRef.current = layout.columnCount;
    }
    prevIdsRef.current = ids;

    return layoutBoardSticky(
      creations,
      layout.columnCount,
      layout.columnWidth,
      assignmentRef.current,
    );
  }, [
    creations,
    layout.ready,
    layout.columnCount,
    layout.columnWidth,
    layoutResetKey,
  ]);

  // Filter / reset: jump to top so leftover scroll doesn't sit in empty packed space
  // and trigger phantom load-more that confuses the board.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
    nearEndSent.current = false;
  }, [layoutResetKey]);

  // Only mount + warm cards near the viewport — full-board mount freezes the UI.
  const visibleCards = useMemo(() => {
    if (cards.length === 0) return cards;
    const top = scrollTop - OVERSCAN_PX;
    const bottom = scrollTop + viewportH + OVERSCAN_PX;
    return cards.filter(
      (card) => card.top + card.height >= top && card.top <= bottom,
    );
  }, [cards, scrollTop, viewportH]);

  useEffect(() => {
    warmLocalPreviews(visibleCards.map((c) => c.creation));
  }, [visibleCards]);

  // Pull missing thumbs near the viewport only (capped batch).
  useEffect(() => {
    const mid = scrollTop + viewportH / 2;
    const missing = cards
      .filter((card) => {
        if (!canFetchLocal(card.creation)) return false;
        if (creationPreviewUrl(card.creation)) return false;
        const key = `${card.id}:thumb`;
        if (ensuredIds.current.has(key)) return false;
        if (card.top + card.height < scrollTop - ENSURE_AHEAD_PX) return false;
        if (card.top > scrollTop + viewportH + ENSURE_AHEAD_PX) return false;
        return true;
      })
      .sort(
        (a, b) =>
          Math.abs(a.top + a.height / 2 - mid) -
          Math.abs(b.top + b.height / 2 - mid),
      )
      .slice(0, ENSURE_BATCH);
    if (missing.length === 0) return;
    const thumbIds: string[] = [];
    for (const card of missing) {
      const key = `${card.id}:thumb`;
      ensuredIds.current.add(key);
      thumbIds.push(card.id);
    }
    void ensureLocal(thumbIds, { fullMedia: false });
  }, [cards, scrollTop, viewportH]);

  const checkNearEnd = useCallback(
    (el: HTMLDivElement) => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
      const leadPx = Math.max(
        LOAD_MORE_MIN_PX,
        el.clientHeight * LOAD_MORE_VIEWPORTS,
      );
      if (remaining < leadPx) {
        if (!nearEndSent.current) {
          nearEndSent.current = true;
          onNearEnd();
        }
      } else {
        nearEndSent.current = false;
      }
    },
    [onNearEnd],
  );

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    checkNearEnd(el);
    if (rafScroll.current) return;
    rafScroll.current = requestAnimationFrame(() => {
      rafScroll.current = 0;
      const node = scrollerRef.current;
      if (!node) return;
      const nextTop = node.scrollTop;
      const nextH = node.clientHeight;
      setScrollTop((prev) => (prev === nextTop ? prev : nextTop));
      setViewportH((prev) => (prev === nextH ? prev : nextH));
    });
  }, [checkNearEnd]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    checkNearEnd(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    // Size changes only — don't re-enter the scroll ensure path on every image decode.
    const ro = new ResizeObserver(() => {
      const node = scrollerRef.current;
      if (!node) return;
      const nextH = node.clientHeight;
      setViewportH((prev) => (prev === nextH ? prev : nextH));
      checkNearEnd(node);
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafScroll.current) cancelAnimationFrame(rafScroll.current);
    };
  }, [onScroll, checkNearEnd]);

  useEffect(() => {
    nearEndSent.current = false;
    const el = scrollerRef.current;
    if (el) checkNearEnd(el);
  }, [creations.length, checkNearEnd]);

  return (
    <div
      ref={scrollerRef}
      className={`creations-virtual-scroller${layout.ready ? " is-ready" : ""}`}
    >
      <div
        className="creations-virtual-space"
        style={{ height: totalHeight }}
        aria-label={`${creations.length} creations`}
        aria-busy={!layout.ready}
      >
        {visibleCards.map((card) => {
          const style = {
            top: card.top,
            left: card.left,
            width: card.width,
            height: card.height,
          } satisfies CSSProperties;
          return (
            <div
              key={card.id}
              className="creations-virtual-item"
              style={style}
            >
              <CreationCard
                creation={card.creation}
                aspectCss={card.aspectCss}
                selected={selectedIds.has(card.id)}
                dimmed={dimmedIds?.has(card.id) ?? false}
                inProject={inProjectIds?.has(card.id) ?? false}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
              />
            </div>
          );
        })}
      </div>
      {!layout.ready ? (
        <div className="creations-virtual-veil" aria-hidden />
      ) : null}
    </div>
  );
}
