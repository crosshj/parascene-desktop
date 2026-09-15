import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ALWAYS_NEXT_MAX,
  occupancyDialogModel,
  occupancySlotWorse,
  placeAtProposedMax,
  productBoostRange,
  namedPriceFromBoost,
  formatCreditsBoost,
  writeStickyMax,
  gpuMethodKind,
  type GpuBid,
  type GpuOccupancy,
  type GpuOccupancyLane,
} from "./gpuOccupancy";

export type OccupancyNegotiateOpts = {
  occupancy: GpuOccupancy;
  lane: GpuOccupancyLane;
  method: string;
  proposedMax: number;
  peek: () => Promise<GpuOccupancy | null>;
};

type OccupancyNegotiateFn = (
  opts: OccupancyNegotiateOpts,
) => Promise<GpuBid | null>;

const CONTEXT_KEY = "__parasceneOccupancyContext";

type OccupancyContextGlobal = typeof globalThis & {
  [CONTEXT_KEY]?: ReturnType<typeof createContext<OccupancyNegotiateFn | null>>;
};

const OccupancyContext =
  (globalThis as OccupancyContextGlobal)[CONTEXT_KEY] ??
  createContext<OccupancyNegotiateFn | null>(null);
(globalThis as OccupancyContextGlobal)[CONTEXT_KEY] = OccupancyContext;

type Pending = OccupancyNegotiateOpts & {
  resolve: (value: GpuBid | null) => void;
  proposedMax: number;
  alwaysNext: boolean;
  lineMoved: boolean;
  confirming: boolean;
};

export function OccupancyProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const downOnBackdrop = useRef(false);

  const close = useCallback((value: GpuBid | null) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(value);
  }, []);

  const negotiate = useCallback<OccupancyNegotiateFn>((opts) => {
    return new Promise<GpuBid | null>((resolve) => {
      if (pendingRef.current) pendingRef.current.resolve(null);
      const next: Pending = {
        ...opts,
        resolve,
        proposedMax: opts.proposedMax,
        alwaysNext: false,
        lineMoved: false,
        confirming: false,
      };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pending.confirming) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      close(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, close]);

  const patch = (partial: Partial<Pending>) => {
    setPending((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      pendingRef.current = next;
      return next;
    });
  };

  const confirm = async () => {
    const current = pendingRef.current;
    if (!current || current.confirming) return;
    patch({ confirming: true, lineMoved: false });
    const bid: GpuBid =
      current.lane === "direct"
        ? { maxBid: current.alwaysNext ? ALWAYS_NEXT_MAX : 0, alwaysNext: current.alwaysNext, charge: 0 }
        : {
            maxBid: current.proposedMax,
            alwaysNext: false,
            charge: namedPriceFromBoost(current.occupancy.cost, current.proposedMax),
          };
    const proposed =
      current.lane === "direct"
        ? bid.alwaysNext
          ? ALWAYS_NEXT_MAX
          : 0
        : current.proposedMax;
    const before = placeAtProposedMax(current.occupancy, proposed);
    const fresh = await current.peek().catch(() => null);
    if (fresh) {
      const after = placeAtProposedMax(fresh, proposed);
      if (occupancySlotWorse(before, after)) {
        patch({
          occupancy: fresh,
          confirming: false,
          lineMoved: true,
        });
        return;
      }
    }
    if (current.lane === "product") {
      writeStickyMax(gpuMethodKind(current.method), current.proposedMax);
    }
    close(bid);
  };

  const value = useMemo(() => negotiate, [negotiate]);
  const model = pending
    ? occupancyDialogModel(pending.occupancy, {
        lane: pending.lane,
        proposedMax: pending.proposedMax,
        alwaysNext: pending.alwaysNext,
      })
    : null;
  const range = pending ? productBoostRange(pending.occupancy.cost) : null;
  const boost = pending ? pending.proposedMax : 0;

  return (
    <OccupancyContext.Provider value={value}>
      {children}
      {pending && model ? (
        <div
          className="confirm-dialog-backdrop"
          role="presentation"
          onPointerDown={(e) => {
            downOnBackdrop.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (
              !pending.confirming &&
              e.target === e.currentTarget &&
              downOnBackdrop.current
            ) {
              close(null);
            }
            downOnBackdrop.current = false;
          }}
        >
          <div
            className="confirm-dialog occupancy-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="occupancy-dialog-title"
            aria-describedby="occupancy-dialog-message"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="occupancy-dialog-title">{model.title}</h2>
            <p id="occupancy-dialog-message" className="muted occupancy-dialog-lede">
              {model.message}
            </p>
            {pending.lineMoved ? (
              <p className="occupancy-line-moved" role="status">
                The line moved. Place below is current.
              </p>
            ) : null}
            {model.stats.length > 0 ? (
              <dl className="occupancy-stats">
                {model.stats.map((row) => (
                  <div key={row.label} className="occupancy-stat">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {pending.lane === "product" && range ? (
              <div className="occupancy-slider">
                <label className="occupancy-slider-label" htmlFor="occupancy-max">
                  Credits Boost
                  <span className="occupancy-slider-value">
                    {formatCreditsBoost(boost)}
                  </span>
                </label>
                <input
                  id="occupancy-max"
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  value={boost}
                  disabled={pending.confirming || range.max <= 0}
                  onChange={(e) =>
                    patch({ proposedMax: Number(e.target.value) })
                  }
                />
                <div className="occupancy-slider-ends">
                  <span>No boost</span>
                  <span>Max boost</span>
                </div>
              </div>
            ) : (
              <label className="occupancy-always-next">
                <input
                  type="checkbox"
                  checked={pending.alwaysNext}
                  disabled={pending.confirming}
                  onChange={(e) => patch({ alwaysNext: e.target.checked })}
                />
                <span>
                  Always next
                  <span className="occupancy-always-next-hint">
                    Goes ahead of anyone paying credits. Can starve that path.
                  </span>
                </span>
              </label>
            )}
            <div className="confirm-dialog-actions occupancy-dialog-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={pending.confirming}
                onClick={() => close(null)}
              >
                {model.cancelLabel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                autoFocus
                disabled={pending.confirming}
                onClick={() => void confirm()}
              >
                {pending.confirming ? "Checking…" : model.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </OccupancyContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useOccupancyNegotiate(): OccupancyNegotiateFn {
  const fn = useContext(OccupancyContext);
  if (!fn) {
    throw new Error("useOccupancyNegotiate must be used within OccupancyProvider");
  }
  return fn;
}
