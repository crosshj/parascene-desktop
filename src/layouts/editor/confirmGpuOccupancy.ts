import { useCallback } from "react";
import { createAuthedSdk } from "../../auth/session";
import { blueQuery } from "../../blue/blueClient";
import { useOccupancyNegotiate } from "./OccupancyDialog";
import {
  applyGpuBid,
  initialProposedMax,
  occupancyIsBusy,
  parseGpuOccupancy,
  type GpuBid,
  type GpuOccupancy,
  type GpuOccupancyLane,
} from "./gpuOccupancy";

const PARASCENE_GPU_SERVER_ID = 6;

export type ConfirmGpuOccupancyOpts = {
  lane: GpuOccupancyLane;
  method: string;
  args?: Record<string, unknown>;
};

export type OccupancySend = { ok: true; bid: GpuBid } | { ok: false };

async function peekGpuOccupancy(
  opts: ConfirmGpuOccupancyOpts,
): Promise<GpuOccupancy | null> {
  const method = opts.method.trim();
  if (!method) return null;
  const args = opts.args ?? {};
  try {
    if (opts.lane === "direct") {
      return parseGpuOccupancy(await blueQuery(method, args));
    }
    const sdk = createAuthedSdk();
    return parseGpuOccupancy(
      await sdk.queryCreate({
        serverId: PARASCENE_GPU_SERVER_ID,
        method,
        args,
      }),
    );
  } catch {
    return null;
  }
}

function idleBid(
  occupancy: GpuOccupancy | null,
  lane: GpuOccupancyLane,
): GpuBid {
  if (lane === "direct") return { maxBid: 0, alwaysNext: false, charge: 0 };
  const list = occupancy?.cost && occupancy.cost > 0 ? occupancy.cost : 0;
  return { maxBid: 0, alwaysNext: false, charge: list };
}

/** Idle or unknown → send at list. Busy → negotiate on the occupancy snapshot. */
export function useConfirmGpuOccupancy() {
  const negotiate = useOccupancyNegotiate();
  return useCallback(
    async (opts: ConfirmGpuOccupancyOpts): Promise<OccupancySend> => {
      const occupancy = await peekGpuOccupancy(opts);
      if (!occupancyIsBusy(occupancy) || !occupancy) {
        return { ok: true, bid: idleBid(occupancy, opts.lane) };
      }
      const bid = await negotiate({
        occupancy,
        lane: opts.lane,
        method: opts.method,
        proposedMax: initialProposedMax(occupancy, opts.method),
        peek: () => peekGpuOccupancy(opts),
      });
      if (!bid) return { ok: false };
      return { ok: true, bid };
    },
    [negotiate],
  );
}

export function argsWithOccupancyBid(
  args: Record<string, unknown>,
  send: OccupancySend,
  lane: GpuOccupancyLane,
): Record<string, unknown> {
  if (!send.ok) return args;
  return applyGpuBid(args, send.bid, lane);
}
