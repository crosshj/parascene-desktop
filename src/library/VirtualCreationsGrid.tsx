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

/** Mount window — large enough that decode/ensure happen before the user arrives. */
const OVERSCAN_PX = 2800;
/** Ask Rust for thumbs even further ahead than mounted cards. */
const ENSURE_AHEAD_PX = 5200;

type CardLayout = {
  id: string;
  creation: Creation;
  top: number;
  left: number;
  width: number;
  height: number;
  aspectCss: string;
};

function layoutBoard(
  items: Creation[],
  columnCount: number,
  columnWidth: number,
): { cards: CardLayout[]; totalHeight: number } {
  const cols = Math.max(1, columnCount);
  const tops = Array.from({ length: cols }, () => 0);
  const cards: CardLayout[] = [];

  for (const creation of items) {
    let col = 0;
    for (let i = 1; i < cols; i++) {
      if (tops[i] < tops[col]) col = i;
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
 * Virtualized masonry from catalog aspect ratios (SQLite).
 * Board previews are local thumbs; full media stays lightbox-only.
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

  const { cards, totalHeight } = useMemo(() => {
    if (!layout.ready) return { cards: [] as CardLayout[], totalHeight: 0 };
    return layoutBoard(creations, layout.columnCount, layout.columnWidth);
  }, [creations, layout.ready, layout.columnCount, layout.columnWidth]);

  const visible = useMemo(() => {
    const minY = scrollTop - OVERSCAN_PX;
    const maxY = scrollTop + viewportH + OVERSCAN_PX;
    return cards.filter((c) => c.top + c.height >= minY && c.top <= maxY);
  }, [cards, scrollTop, viewportH]);

  useEffect(() => {
    warmLocalPreviews(creations);
  }, [creations]);

  useEffect(() => {
    const maxY = scrollTop + viewportH + ENSURE_AHEAD_PX;
    const thumbIds: string[] = [];
    for (const card of cards) {
      if (card.top > maxY) continue;
      if (!canFetchLocal(card.creation)) continue;
      if (creationPreviewUrl(card.creation)) continue;
      const key = `${card.id}:thumb`;
      if (ensuredIds.current.has(key)) continue;
      ensuredIds.current.add(key);
      thumbIds.push(card.id);
    }
    if (thumbIds.length > 0) void ensureLocal(thumbIds, { fullMedia: false });
  }, [cards, scrollTop, viewportH]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewportH(el.clientHeight);
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining < 2000) {
      if (!nearEndSent.current) {
        nearEndSent.current = true;
        onNearEnd();
      }
    } else {
      nearEndSent.current = false;
    }
  }, [onNearEnd]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [onScroll]);

  useEffect(() => {
    nearEndSent.current = false;
    onScroll();
  }, [creations.length, onScroll]);

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
        {visible.map((card) => {
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
      <div className="creations-virtual-veil" aria-hidden />
    </div>
  );
}
