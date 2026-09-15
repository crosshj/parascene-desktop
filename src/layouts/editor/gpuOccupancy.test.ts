import { describe, expect, it } from "vitest";
import {
  ALWAYS_NEXT_MAX,
  applyGpuBid,
  boostFromNamedPrice,
  formatCreditsBoost,
  formatOccupancyEta,
  namedPriceFromBoost,
  occupancyDialogModel,
  occupancyIsBusy,
  parseGpuOccupancy,
  placeAtProposedMax,
  productBoostRange,
  resolveProductNamedPrice,
} from "./gpuOccupancy";

describe("parseGpuOccupancy", () => {
  it("returns null when the payload has no idle flag", () => {
    expect(parseGpuOccupancy({ supported: true, cost: 10 })).toBeNull();
  });

  it("parses a busy video without leaking extra fields", () => {
    const occupancy = parseGpuOccupancy({
      supported: true,
      cost: 1,
      idle: false,
      running: { kind: "video", family: "wan", prompt: "secret" },
      running_eta_s: 90,
      ahead: 2,
      eta_s: 720,
      pending: [
        { max: 12, eta_s: 400, kind: "video", prompt: "secret dog" },
        { max: 1, eta_s: 230, kind: "still" },
      ],
      highest_max: 12,
    });
    expect(occupancy).toEqual({
      supported: true,
      cost: 1,
      idle: false,
      running: { kind: "video", family: "wan" },
      running_eta_s: 90,
      ahead: 2,
      eta_s: 720,
      pending: [
        { max: 12, eta_s: 400, kind: "video" },
        { max: 1, eta_s: 230, kind: "still" },
      ],
      highest_max: 12,
    });
    expect(occupancyIsBusy(occupancy)).toBe(true);
  });
});

describe("placeAtProposedMax", () => {
  const occupancy = parseGpuOccupancy({
    idle: false,
    running: { kind: "still", family: "flux" },
    running_eta_s: 40,
    ahead: 3,
    eta_s: 670,
    cost: 1,
    pending: [
      { max: 12, eta_s: 400, kind: "video" },
      { max: 1, eta_s: 120, kind: "still" },
      { max: 1, eta_s: 110, kind: "still" },
    ],
    highest_max: 12,
  });

  it("sits behind equal maxes (FIFO among equals)", () => {
    expect(occupancy).not.toBeNull();
    expect(placeAtProposedMax(occupancy!, 1)).toEqual({
      ahead: 3,
      eta_s: 670,
      place: 4,
    });
  });

  it("jumps a lower boost even when that job's list price is higher", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "video", family: "wan" },
      running_eta_s: 60,
      ahead: 2,
      eta_s: 360,
      cost: 0.1,
      pending: [
        { max: 0, eta_s: 200, kind: "video" },
        { max: 0, eta_s: 100, kind: "still" },
      ],
      highest_max: 0,
    });
    expect(placeAtProposedMax(occupancy!, 0).place).toBe(3);
    expect(placeAtProposedMax(occupancy!, 0.5).place).toBe(1);
  });

  it("treats an empty pending snapshot as boost 0 so a boost still jumps", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "still", family: "flux" },
      running_eta_s: 40,
      ahead: 2,
      eta_s: 360,
      cost: 0.1,
    });
    expect(placeAtProposedMax(occupancy!, 0).place).toBe(3);
    expect(placeAtProposedMax(occupancy!, 0.5).place).toBe(1);
  });
});

describe("credits boost", () => {
  it("is added to list in 0.5 steps and cannot undercut list", () => {
    expect(productBoostRange(0.1)).toEqual({ min: 0, max: 49.5, step: 0.5 });
    expect(namedPriceFromBoost(0.1, 0)).toBe(0.1);
    expect(namedPriceFromBoost(0.1, 0.5)).toBe(0.6);
    expect(namedPriceFromBoost(0.1, 0.4)).toBe(0.6);
    expect(boostFromNamedPrice(0.1, 0.6)).toBe(0.5);
    expect(formatCreditsBoost(0)).toBe("0");
    expect(formatCreditsBoost(0.5)).toBe("+0.5");
    expect(formatCreditsBoost(2)).toBe("+2");
  });
});

describe("resolveProductNamedPrice", () => {
  it("charges list plus boost and sends boost as max_bid", () => {
    expect(resolveProductNamedPrice(0.05, 0.1)).toEqual({
      ok: true,
      cost: 0.1,
      max_bid: 0,
    });
    expect(resolveProductNamedPrice(0.5, 0.1)).toEqual({
      ok: true,
      cost: 0.6,
      max_bid: 0.5,
    });
    expect(resolveProductNamedPrice(80, 1)).toEqual({
      ok: true,
      cost: 50,
      max_bid: 49,
    });
    expect(resolveProductNamedPrice(undefined, 1)).toEqual({
      ok: true,
      cost: 1,
      max_bid: 0,
    });
  });
});

describe("applyGpuBid", () => {
  it("sends always_next on direct and max_bid on product", () => {
    expect(
      applyGpuBid({ prompt: "x" }, { maxBid: ALWAYS_NEXT_MAX, alwaysNext: true }, "direct"),
    ).toEqual({ prompt: "x", always_next: true });
    expect(
      applyGpuBid({ prompt: "x" }, { maxBid: 12, alwaysNext: false }, "product"),
    ).toEqual({ prompt: "x", max_bid: 12, credits_boost: 12 });
    expect(
      applyGpuBid({ prompt: "x" }, { maxBid: 0, alwaysNext: false }, "product"),
    ).toEqual({ prompt: "x" });
  });
});

describe("occupancyDialogModel", () => {
  it("does not brand the product path as Blue", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "still", family: "flux" },
      ahead: 0,
      eta_s: 40,
      cost: 0.1,
    });
    expect(occupancy).not.toBeNull();
    const model = occupancyDialogModel(occupancy!, { lane: "product" });
    expect(model.title).toBe("This server is busy");
    expect(model.title).not.toMatch(/Blue/i);
    expect(model.message).toMatch(/next/i);
    expect(model.stats.map((s) => s.label)).toEqual(["Now running", "Credits"]);
  });

  it("does not repeat place or wait in the stats", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "video", family: "minimax_r2v" },
      ahead: 5,
      eta_s: 2040,
      cost: 0.1,
    });
    const model = occupancyDialogModel(occupancy!, { lane: "product" });
    expect(model.message).toMatch(/6th in line/);
    expect(model.message).toMatch(/About 34 min/);
    expect(model.stats.map((s) => s.label)).toEqual(["Now running", "Credits"]);
    expect(model.stats[0]?.value).toBe("Video · minimax r2v");
  });

  it("names Blue on the direct lane and skips credits", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "video", family: "ltx" },
      ahead: 2,
      eta_s: 720,
      cost: 1,
    });
    const model = occupancyDialogModel(occupancy!, { lane: "direct" });
    expect(model.title).toBe("Blue is busy");
    expect(model.message).toMatch(/3rd/);
    expect(formatOccupancyEta(720)).toBe("about 12 min");
    expect(model.stats.map((s) => s.label)).toEqual(["Now running"]);
  });

  it("updates place from the pending snapshot when the slider moves", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "video", family: "wan" },
      running_eta_s: 60,
      ahead: 2,
      eta_s: 360,
      cost: 1,
      pending: [
        { max: 50, eta_s: 200, kind: "video" },
        { max: 1, eta_s: 100, kind: "still" },
      ],
      highest_max: 50,
    });
    const atList = occupancyDialogModel(occupancy!, {
      lane: "product",
      proposedMax: 0,
    });
    const atCap = occupancyDialogModel(occupancy!, {
      lane: "product",
      proposedMax: 50,
    });
    expect(atList.message).toMatch(/3rd in line/);
    expect(atList.stats.find((s) => s.label === "Credits")?.value).toBe("1");
    expect(atCap.message).toMatch(/2nd in line/);
    expect(atCap.stats.find((s) => s.label === "Credits")?.value).toBe("50");
    expect(atCap.capNote).toMatch(/boosted/i);
  });

  it("updates place from boost even when pending is missing", () => {
    const occupancy = parseGpuOccupancy({
      idle: false,
      running: { kind: "video", family: "wan" },
      running_eta_s: 60,
      ahead: 2,
      eta_s: 360,
      cost: 1,
    });
    const atList = occupancyDialogModel(occupancy!, {
      lane: "product",
      proposedMax: 0,
    });
    const boosted = occupancyDialogModel(occupancy!, {
      lane: "product",
      proposedMax: 0.5,
    });
    expect(atList.message).toMatch(/3rd in line/);
    expect(boosted.message).toMatch(/You'll be next/);
  });
});
