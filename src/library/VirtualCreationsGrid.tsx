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

/** Ask Rust for missing thumbs across the whole loaded catalogue window. */
const ENSURE_AHEAD_PX = 20000;
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

/**
 * Masonry board from catalog aspect ratios (SQLite).
 *
 * Every creation already loaded into the feed stays mounted. Catalogue paging
 * bounds how many nodes we keep; content-visibility skips off-screen paint.
 */
export function VirtualCreationsGrid({
  creations,
  onOpen,
  onNearEnd,
}: {
  creations: Creation[];
  onOpen: (creation: Creation) => void;
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
  const rafScroll = useRef(0);

  // Start decode before child layout effects so remounts can paint instantly.
  warmLocalPreviews(creations);

  const { cards, totalHeight } = useMemo(() => {
    if (!layout.ready) return { cards: [] as CardLayout[], totalHeight: 0 };
    if (colsRef.current !== layout.columnCount) {
      colsRef.current = layout.columnCount;
      assignmentRef.current = new Map();
    }
    return layoutBoardSticky(
      creations,
      layout.columnCount,
      layout.columnWidth,
      assignmentRef.current,
    );
  }, [creations, layout.ready, layout.columnCount, layout.columnWidth]);

  useEffect(() => {
    warmLocalPreviews(creations);
  }, [creations]);

  // Pull any missing thumbs for the loaded catalogue, nearest-to-viewport first.
  useEffect(() => {
    const mid = scrollTop + viewportH / 2;
    const missing = cards
      .filter((card) => {
        if (!canFetchLocal(card.creation)) return false;
        if (creationPreviewUrl(card.creation)) return false;
        const key = `${card.id}:thumb`;
        if (ensuredIds.current.has(key)) return false;
        if (card.top > scrollTop + viewportH + ENSURE_AHEAD_PX) return false;
        return true;
      })
      .sort(
        (a, b) =>
          Math.abs(a.top + a.height / 2 - mid) -
          Math.abs(b.top + b.height / 2 - mid),
      );
    if (missing.length === 0) return;
    const thumbIds: string[] = [];
    for (const card of missing) {
      const key = `${card.id}:thumb`;
      ensuredIds.current.add(key);
      thumbIds.push(card.id);
    }
    void ensureLocal(thumbIds, { fullMedia: false });
  }, [cards, creations, scrollTop, viewportH]);

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
      setScrollTop(node.scrollTop);
      setViewportH(node.clientHeight);
    });
  }, [checkNearEnd]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    checkNearEnd(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
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
        {cards.map((card) => {
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
                onOpen={onOpen}
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
