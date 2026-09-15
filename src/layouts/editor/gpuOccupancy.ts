export type GpuOccupancyLane = "product" | "direct";

export type GpuOccupancyRunning = {
  kind: "still" | "video";
  family?: string;
};

export type GpuOccupancyPending = {
  max: number;
  eta_s: number;
  kind: "still" | "video";
};

export type GpuOccupancy = {
  idle: boolean;
  running: GpuOccupancyRunning | null;
  running_eta_s: number;
  ahead: number;
  eta_s: number;
  cost: number;
  supported: boolean;
  pending: GpuOccupancyPending[];
  highest_max: number;
};

export type OccupancyStat = { label: string; value: string };

export type GpuBid = {
  /** Credits Boost (product) or 0 / always-next (direct). */
  maxBid: number;
  alwaysNext: boolean;
  /** List + boost. What Parascene charges on the product path. */
  charge?: number;
};

export const PRODUCT_MAX_CAP = 50;
export const ALWAYS_NEXT_MAX = 51;
export const PRODUCT_BOOST_STEP = 0.5;

const STICKY_IMAGE_KEY = "parascene.gpuBoost.image";
const STICKY_VIDEO_KEY = "parascene.gpuBoost.video";

const VIDEO_METHODS = new Set([
  "text2video",
  "image2video",
  "audio2video",
  "video2video",
  "reference2video",
]);

export function gpuMethodKind(method: string): "image" | "video" {
  return VIDEO_METHODS.has(String(method || "").trim()) ? "video" : "image";
}

function listCost(cost: number): number {
  return Number.isFinite(cost) && cost > 0 ? cost : 0.1;
}

function snapToHalf(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 2) / 2;
}

export function productSliderRange(cost: number): { min: number; max: number } {
  const min = listCost(cost);
  return { min, max: Math.max(PRODUCT_MAX_CAP, min) };
}

/** Credits Boost slider: 0 at list, +0.5 steps, total clamped at the cap. */
export function productBoostRange(cost: number): {
  min: number;
  max: number;
  step: number;
} {
  const { min: list, max: cap } = productSliderRange(cost);
  const max = Math.max(
    0,
    Math.floor((cap - list) / PRODUCT_BOOST_STEP) * PRODUCT_BOOST_STEP,
  );
  return { min: 0, max, step: PRODUCT_BOOST_STEP };
}

export function namedPriceFromBoost(cost: number, boost: unknown): number {
  const { min: list, max: cap } = productSliderRange(cost);
  const { max: maxBoost } = productBoostRange(list);
  const raw = Number(boost);
  const b = Number.isFinite(raw)
    ? Math.min(maxBoost, Math.max(0, snapToHalf(raw)))
    : 0;
  return Math.min(cap, Math.round((list + b) * 10) / 10);
}

export function boostFromNamedPrice(cost: number, named: unknown): number {
  const { min: list } = productSliderRange(cost);
  const { max: maxBoost } = productBoostRange(list);
  const raw = Number(named);
  if (!Number.isFinite(raw)) return 0;
  return Math.min(maxBoost, Math.max(0, snapToHalf(raw - list)));
}

export function formatCreditsBoost(boost: number): string {
  const snapped = snapToHalf(Number.isFinite(boost) ? boost : 0);
  if (snapped <= 0) return "0";
  return snapped % 1 === 0 ? `+${snapped}` : `+${snapped.toFixed(1)}`;
}

export function clampProductBoost(raw: unknown, cost: number): number {
  const { max } = productBoostRange(cost);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.max(0, snapToHalf(n)));
}

export function clampProductMaxBid(raw: unknown, cost: number): number {
  return namedPriceFromBoost(cost, clampProductBoost(raw, cost));
}

/** Charge list + boost. `rawMaxBid` is Credits Boost, not the job total. */
export function resolveProductNamedPrice(
  rawMaxBid: unknown,
  list: number,
): { ok: true; cost: number; max_bid: number } {
  const boost = clampProductBoost(rawMaxBid, list);
  return {
    ok: true,
    cost: namedPriceFromBoost(list, boost),
    max_bid: boost,
  };
}

export function readStickyMax(kind: "image" | "video"): number | null {
  try {
    const raw = localStorage.getItem(
      kind === "video" ? STICKY_VIDEO_KEY : STICKY_IMAGE_KEY,
    );
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeStickyMax(kind: "image" | "video", value: number): void {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return;
  try {
    localStorage.setItem(
      kind === "video" ? STICKY_VIDEO_KEY : STICKY_IMAGE_KEY,
      String(n),
    );
  } catch {
    /* ignore quota */
  }
}

export function initialProposedMax(
  occupancy: GpuOccupancy,
  method: string,
): number {
  const sticky = readStickyMax(gpuMethodKind(method));
  if (sticky == null) return 0;
  return clampProductBoost(sticky, occupancy.cost);
}

export function applyGpuBid(
  args: Record<string, unknown>,
  bid: GpuBid | null | undefined,
  lane: GpuOccupancyLane,
): Record<string, unknown> {
  const next = { ...args };
  delete next.max_bid;
  delete next.always_next;
  delete next.credits_boost;
  if (!bid) return next;
  if (lane === "direct") {
    next.always_next = bid.alwaysNext === true;
    return next;
  }
  const boost = Number(bid.maxBid);
  if (Number.isFinite(boost) && boost > 0) {
    const snapped = Math.round(boost * 2) / 2;
    next.max_bid = snapped;
    next.credits_boost = snapped;
  }
  return next;
}

function parsePending(raw: unknown): GpuOccupancyPending[] {
  if (!Array.isArray(raw)) return [];
  const rows: GpuOccupancyPending[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const max = Number(row.boost ?? row.max);
    const eta = Number(row.eta_s);
    rows.push({
      max: Number.isFinite(max) && max > 0 ? max : 0,
      eta_s: Number.isFinite(eta) && eta > 0 ? Math.round(eta) : 0,
      kind: row.kind === "video" ? "video" : "still",
    });
  }
  return rows;
}

export function parseGpuOccupancy(raw: unknown): GpuOccupancy | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.idle !== "boolean") return null;
  const aheadRaw = Number(row.ahead);
  const etaRaw = Number(row.eta_s);
  let running: GpuOccupancyRunning | null = null;
  if (row.running && typeof row.running === "object") {
    const r = row.running as Record<string, unknown>;
    const kind = r.kind === "video" ? "video" : "still";
    const family =
      typeof r.family === "string" && r.family.trim() ? r.family.trim() : "";
    running = family ? { kind, family } : { kind };
  }
  const cost = Number(row.cost);
  const pending = parsePending(row.pending);
  const highestRaw = Number(row.highest_max);
  const runningEtaRaw = Number(row.running_eta_s);
  return {
    idle: row.idle,
    running,
    running_eta_s:
      Number.isFinite(runningEtaRaw) && runningEtaRaw > 0
        ? Math.round(runningEtaRaw)
        : 0,
    ahead: Number.isFinite(aheadRaw) && aheadRaw > 0 ? Math.floor(aheadRaw) : 0,
    eta_s: Number.isFinite(etaRaw) && etaRaw > 0 ? Math.round(etaRaw) : 0,
    cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
    supported: row.supported === true || row.supported === "true",
    pending,
    highest_max:
      Number.isFinite(highestRaw) && highestRaw > 0
        ? highestRaw
        : pending.reduce((high, p) => Math.max(high, p.max), 0),
  };
}

export function occupancyIsBusy(occupancy: GpuOccupancy | null): boolean {
  return Boolean(occupancy && occupancy.idle === false);
}

export function formatOccupancyEta(seconds: number): string {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "a moment";
  if (s < 45) return "under a minute";
  const mins = Math.max(1, Math.round(s / 60));
  return mins === 1 ? "about 1 min" : `about ${mins} min`;
}

export function placeAtProposedMax(
  occupancy: GpuOccupancy,
  proposedMax: number,
): { ahead: number; eta_s: number; place: number } {
  const pending = occupancy.pending;
  const bidRaw = Number(proposedMax);
  const bid = Number.isFinite(bidRaw) ? bidRaw : 0;
  const runningEta = occupancy.running
    ? occupancy.running_eta_s || occupancy.eta_s
    : occupancy.eta_s;

  if (!pending.length) {
    const ahead = occupancy.ahead;
    if (ahead <= 0) {
      return { ahead: 0, eta_s: runningEta, place: 1 };
    }
    // No boost snapshot: treat the line as boost 0 so a boost jumps them.
    if (bid > 0) {
      return { ahead: 0, eta_s: occupancy.running_eta_s || runningEta, place: 1 };
    }
    return {
      ahead,
      eta_s: occupancy.eta_s,
      place: ahead + 1,
    };
  }

  let ahead = 0;
  let eta = occupancy.running ? occupancy.running_eta_s || 0 : 0;
  if (occupancy.running && eta <= 0) {
    eta = Math.max(
      0,
      occupancy.eta_s - pending.reduce((sum, row) => sum + row.eta_s, 0),
    );
  }
  for (const row of pending) {
    if (row.max >= bid) {
      ahead += 1;
      eta += row.eta_s;
    }
  }
  if (eta > 3 * 3600) eta = 3 * 3600;
  return { ahead, eta_s: Math.round(eta), place: ahead + 1 };
}

export function occupancySlotWorse(
  previous: { ahead: number; eta_s: number },
  next: { ahead: number; eta_s: number },
): boolean {
  return next.ahead > previous.ahead || next.eta_s > previous.eta_s + 30;
}

function ordinal(n: number): string {
  const v = Math.floor(Number(n) || 0);
  const mod100 = v % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`;
  switch (v % 10) {
    case 1:
      return `${v}st`;
    case 2:
      return `${v}nd`;
    case 3:
      return `${v}rd`;
    default:
      return `${v}th`;
  }
}

function kindLabel(kind: "still" | "video"): string {
  return kind === "video" ? "Video" : "Still";
}

function familyLabel(family?: string): string {
  return family ? family.replace(/[_-]+/g, " ") : "";
}

function runningLabel(running: GpuOccupancyRunning | null): string {
  if (!running) return "Waiting to start";
  const fam = familyLabel(running.family);
  return fam ? `${kindLabel(running.kind)} · ${fam}` : kindLabel(running.kind);
}

export function occupancyDialogModel(
  occupancy: GpuOccupancy,
  opts?: {
    lane?: GpuOccupancyLane;
    proposedMax?: number;
    alwaysNext?: boolean;
  },
): {
  title: string;
  message: string;
  stats: OccupancyStat[];
  confirmLabel: string;
  cancelLabel: string;
  capNote: string | null;
} {
  const lane = opts?.lane ?? "product";
  const proposed =
    lane === "direct"
      ? opts?.alwaysNext
        ? ALWAYS_NEXT_MAX
        : 0
      : clampProductBoost(opts?.proposedMax, occupancy.cost);
  const placed = placeAtProposedMax(occupancy, proposed);
  const wait = formatOccupancyEta(placed.eta_s);
  const title = lane === "direct" ? "Blue is busy" : "This server is busy";
  const placeLine =
    placed.place <= 1
      ? "You'll be next."
      : `You'll be ${ordinal(placed.place)} in line.`;
  let message = `${placeLine} ${wait[0].toUpperCase()}${wait.slice(1)} until generating starts.`;
  const maxBoost = productBoostRange(occupancy.cost).max;
  const atCap =
    lane === "product" &&
    proposed >= maxBoost &&
    maxBoost > 0 &&
    occupancy.highest_max >= proposed &&
    placed.place > 1;
  const capNote = atCap
    ? "Others boosted the same or more. This is the max for this method."
    : null;
  if (capNote) message = `${message} ${capNote}`;
  const stats: OccupancyStat[] = [
    { label: "Now running", value: runningLabel(occupancy.running) },
  ];
  if (lane !== "direct") {
    const credits = namedPriceFromBoost(occupancy.cost, proposed);
    if (credits > 0) {
      stats.push({
        label: "Credits",
        value:
          credits === 1
            ? "1"
            : String(Math.round(credits * 10) / 10),
      });
    }
  }
  return {
    title,
    message,
    stats,
    confirmLabel: "Generate",
    cancelLabel: "Cancel",
    capNote,
  };
}
