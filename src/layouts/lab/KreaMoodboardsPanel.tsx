/**
 * Labs browser for checked-in Krea preset moodboards.
 * Primary action: copy the board UUID for Krea 2 generation `moodboards: [{ id }]`.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import catalog from "../../data/krea-moodboards.json";
import { copyTextToClipboard } from "../../ui/clipboard";

export type KreaMoodboard = {
  id: string;
  slug: string;
  name: string;
  keywords: string[];
  profile: string;
  isStaffPick: boolean;
  createdAt: string | null;
  previews: string[];
};

type CatalogFile = {
  fetchedAt?: string;
  total?: number;
  boards: KreaMoodboard[];
};

const BOARDS = (catalog as CatalogFile).boards ?? [];
const FETCHED_AT = (catalog as CatalogFile).fetchedAt ?? null;

const ROW_HEIGHT = 88;
const OVERSCAN_PX = 800;
const DETAIL_WIDTH_KEY = "parascene.lab.kreaMoodboardDetailWidth";
const DETAIL_MIN = 280;
const DETAIL_MAX = 720;
const DETAIL_DEFAULT = 420;

function kreaMoodboardPageUrl(id: string): string {
  return `https://www.krea.ai/moodboards?share=${encodeURIComponent(id)}`;
}

function clampDetailWidth(w: number, splitWidth?: number): number {
  const maxFromSplit =
    splitWidth != null ? Math.max(DETAIL_MIN, splitWidth - 240) : DETAIL_MAX;
  return Math.min(DETAIL_MAX, maxFromSplit, Math.max(DETAIL_MIN, Math.round(w)));
}

function loadDetailWidth(): number {
  try {
    const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
    if (!raw) return DETAIL_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DETAIL_DEFAULT;
    return clampDetailWidth(n);
  } catch {
    return DETAIL_DEFAULT;
  }
}

function matchesQuery(board: KreaMoodboard, q: string): boolean {
  if (!q) return true;
  if (board.name.toLowerCase().includes(q)) return true;
  if (board.id.toLowerCase().includes(q)) return true;
  if (board.slug.toLowerCase().includes(q)) return true;
  if (board.profile.toLowerCase().includes(q)) return true;
  for (const kw of board.keywords) {
    if (kw.toLowerCase().includes(q)) return true;
  }
  return false;
}

function DetailClose({
  onClick,
  overlay,
}: {
  onClick: () => void;
  overlay?: boolean;
}) {
  return (
    <button
      type="button"
      className={
        overlay
          ? "lab-replicate-detail-close is-overlay"
          : "lab-replicate-detail-close"
      }
      aria-label="Close detail"
      onClick={onClick}
    >
      ×
    </button>
  );
}

export function KreaMoodboardsPanel() {
  const [query, setQuery] = useState("");
  const [queryApplied, setQueryApplied] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(loadDetailWidth);
  const [splitDragging, setSplitDragging] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);

  const splitRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  const filtered = useMemo(() => {
    const q = queryApplied.trim().toLowerCase();
    if (!q) return BOARDS;
    return BOARDS.filter((b) => matchesQuery(b, q));
  }, [queryApplied]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    const board = BOARDS.find((b) => b.id === selectedId);
    if (!board || !filtered.some((b) => b.id === selectedId)) return null;
    return board;
  }, [selectedId, filtered]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScrollTop(0);
  }, [queryApplied]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = splitDragRef.current;
      if (!drag) return;
      const next = drag.startWidth - (event.clientX - drag.startX);
      setDetailWidth(clampDetailWidth(next, splitRef.current?.clientWidth));
    };
    const onUp = () => {
      if (!splitDragRef.current) return;
      splitDragRef.current = null;
      setSplitDragging(false);
      setDetailWidth((w) => {
        try {
          localStorage.setItem(DETAIL_WIDTH_KEY, String(w));
        } catch {
          // ignore
        }
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    const split = splitRef.current;
    if (!split) return;
    const reclamp = () => {
      setDetailWidth((w) => clampDetailWidth(w, split.clientWidth));
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(split);
    return () => ro.disconnect();
  }, []);

  const commitSearch = useCallback((raw: string) => {
    setQueryApplied(raw.trim());
    setCopyNote(null);
  }, []);

  const onCopyId = useCallback(async (id: string) => {
    try {
      await copyTextToClipboard(id);
      setCopyNote("UUID copied");
    } catch {
      setCopyNote("Copy failed");
    }
  }, []);

  const range = useMemo(() => {
    const total = filtered.length;
    if (total <= 0) return { start: 0, end: 0 };
    const start = Math.max(
      0,
      Math.floor((scrollTop - OVERSCAN_PX) / ROW_HEIGHT),
    );
    const end = Math.min(
      total,
      Math.ceil((scrollTop + viewportH + OVERSCAN_PX) / ROW_HEIGHT),
    );
    return { start, end };
  }, [filtered.length, scrollTop, viewportH]);

  const totalHeight = filtered.length * ROW_HEIGHT;
  const indices: number[] = [];
  for (let i = range.start; i < range.end; i++) indices.push(i);

  const onResizerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    splitDragRef.current = {
      startX: e.clientX,
      startWidth: detailWidth,
    };
    setSplitDragging(true);
  };

  return (
    <div className="lab-replicate lab-krea">
      <header className="lab-replicate-titlebar">
        <h2 className="lab-replicate-title">Krea moodboards</h2>
        <div className="lab-replicate-toolbar">
          <span className="muted lab-replicate-copy-note">
            {BOARDS.length.toLocaleString()} presets
            {FETCHED_AT
              ? ` · catalog ${new Date(FETCHED_AT).toLocaleDateString()}`
              : null}
          </span>
        </div>
      </header>

      <div className="lab-replicate-search">
        <input
          className="control"
          type="search"
          value={query}
          onChange={(e) => {
            const next = e.target.value;
            setQuery(next);
            if (!next.trim() && queryApplied) {
              setQueryApplied("");
              setCopyNote(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitSearch(e.currentTarget.value);
          }}
          placeholder="Filter by name, keywords, profile, or UUID"
          aria-label="Filter moodboards"
        />
        <button
          type="button"
          className="btn ghost"
          onClick={() => commitSearch(query)}
        >
          Search
        </button>
        {copyNote ? (
          <span className="muted lab-replicate-copy-note">{copyNote}</span>
        ) : null}
      </div>

      <div
        ref={splitRef}
        className={
          selected ? "lab-replicate-split has-detail" : "lab-replicate-split"
        }
      >
        <div className="lab-replicate-list-pane">
          {filtered.length === 0 ? (
            <p className="muted lab-replicate-empty">No moodboards match.</p>
          ) : (
            <div
              ref={scrollerRef}
              className="lab-replicate-virtual"
              role="list"
              onScroll={() => {
                const el = scrollerRef.current;
                if (el) setScrollTop(el.scrollTop);
              }}
            >
              <div
                className="lab-replicate-virtual-space"
                style={{ height: totalHeight }}
              >
                {indices.map((index) => {
                  const board = filtered[index];
                  if (!board) return null;
                  const active = selected?.id === board.id;
                  const thumb = board.previews[0];
                  return (
                    <button
                      key={board.id}
                      type="button"
                      role="listitem"
                      className={[
                        "lab-replicate-row",
                        active ? "is-active" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{
                        position: "absolute",
                        top: index * ROW_HEIGHT,
                        left: 0,
                        right: 0,
                        height: ROW_HEIGHT,
                      }}
                      onClick={() => {
                        setSelectedId(board.id);
                        setCopyNote(null);
                      }}
                    >
                      {thumb ? (
                        <img
                          className="lab-replicate-thumb"
                          src={thumb}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span
                          className="lab-replicate-thumb is-empty"
                          aria-hidden
                        />
                      )}
                      <span className="lab-replicate-row-body">
                        <span className="lab-replicate-row-title">
                          {board.name}
                        </span>
                        <span className="lab-replicate-row-meta">
                          {board.isStaffPick ? (
                            <span className="lab-replicate-status-tag is-enabled">
                              Staff pick
                            </span>
                          ) : null}
                          <span className="muted">
                            {board.keywords.slice(0, 3).join(" · ")}
                          </span>
                        </span>
                        <span className="muted lab-replicate-row-desc">
                          {board.profile}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {selected ? (
          <>
            <button
              type="button"
              className={
                splitDragging
                  ? "lab-replicate-split-resizer is-dragging"
                  : "lab-replicate-split-resizer"
              }
              aria-label="Resize detail pane"
              onPointerDown={onResizerDown}
            />
            <aside
              className="lab-replicate-detail"
              style={{ width: detailWidth, flex: `0 0 ${detailWidth}px` }}
            >
              <header className="lab-replicate-detail-header is-with-close">
                <DetailClose onClick={() => setSelectedId(null)} />
                <h3>{selected.name}</h3>
                <p className="lab-replicate-detail-links">
                  <button
                    type="button"
                    className="lab-replicate-external-link"
                    onClick={() => {
                      void openUrl(kreaMoodboardPageUrl(selected.id));
                    }}
                  >
                    Open on Krea
                  </button>
                </p>
                {selected.isStaffPick ? (
                  <p className="muted">Staff pick</p>
                ) : null}
              </header>

              {selected.previews.length > 0 ? (
                <div className="lab-krea-previews">
                  {selected.previews.map((url) => (
                    <img
                      key={url}
                      className="lab-krea-preview"
                      src={url}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                  ))}
                </div>
              ) : null}

              <div className="lab-krea-id-block">
                <label className="muted" htmlFor="krea-moodboard-id">
                  Moodboard UUID
                </label>
                <code id="krea-moodboard-id" className="lab-krea-id">
                  {selected.id}
                </code>
              </div>

              <div className="lab-replicate-detail-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void onCopyId(selected.id)}
                >
                  Copy UUID
                </button>
              </div>

              {selected.keywords.length > 0 ? (
                <div className="lab-replicate-chips" aria-label="Keywords">
                  {selected.keywords.map((kw) => (
                    <span key={kw} className="lab-replicate-chip">
                      {kw}
                    </span>
                  ))}
                </div>
              ) : null}

              {selected.profile ? (
                <p className="lab-krea-profile">{selected.profile}</p>
              ) : null}
            </aside>
          </>
        ) : null}
      </div>

      <footer className="lab-replicate-statusbar">
        <p className="lab-replicate-status">
          <strong>{filtered.length.toLocaleString()}</strong>
          <span className="muted">
            {queryApplied ? "matching" : "boards"}
            {selected ? ` · selected ${selected.name}` : ""}
          </span>
        </p>
      </footer>
    </div>
  );
}
