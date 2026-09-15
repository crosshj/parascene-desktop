/** GPU wait: queued vs generating vs timed out. Same status lines as www. */

export type GpuWaitPhase = "in_line" | "generating" | "timed_out";

export function gpuWaitPhaseFromStatus(
  status: string | null | undefined,
): GpuWaitPhase | null {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "timed_out" || s === "timeout") return "timed_out";
  if (s === "processing" || s === "running") return "generating";
  if (
    s === "queued" ||
    s === "pending" ||
    s === "creating" ||
    s === "starting" ||
    s === "waiting"
  ) {
    return "in_line";
  }
  return null;
}

export function gpuWaitPhaseFromNote(
  note: string | null | undefined,
): GpuWaitPhase | null {
  const n = String(note ?? "").trim();
  if (/^timed out/i.test(n) || /^timeout/i.test(n)) return "timed_out";
  if (/^queued/i.test(n) || /^in line/i.test(n)) return "in_line";
  if (/^generating/i.test(n)) return "generating";
  if (/\((?:processing|running)\)/i.test(n)) return "generating";
  if (/\((?:queued|pending|creating|starting|waiting)\)/i.test(n)) {
    return "in_line";
  }
  if (/^waiting for \d+/i.test(n)) return "in_line";
  if (/^waiting for blue/i.test(n)) return "in_line";
  return null;
}

export function gpuWaitTitle(
  phase: GpuWaitPhase | null | undefined,
  fallback = "Generating…",
): string {
  if (phase === "in_line") return "QUEUED";
  if (phase === "generating") return "Generating…";
  if (phase === "timed_out") return "TIMED OUT";
  return fallback;
}

export function isGpuWaitInLine(
  note?: string | null,
  status?: string | null,
): boolean {
  return (
    gpuWaitPhaseFromNote(note) === "in_line" ||
    gpuWaitPhaseFromStatus(status) === "in_line"
  );
}

export function gpuWaitPlaceFromNote(
  note: string | null | undefined,
): number | null {
  const m = String(note ?? "").match(/(?:in line|queued)\s*·\s*(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function gpuWaitPlaceLine(place: number | null | undefined): string {
  const n = Number(place);
  return Number.isFinite(n) && n > 0 ? `${n} in line` : "";
}
