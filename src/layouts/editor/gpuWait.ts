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
  if (/^pending$/i.test(n) || /^waiting$/i.test(n) || /^creating$/i.test(n)) {
    return "in_line";
  }
  if (/parascene is busy/i.test(n) || /^checking creation/i.test(n)) {
    return "in_line";
  }
  // Startup notes ("Starting…", "Requesting…", "Working…") arrive before the
  // backend has said anything. Every GPU flow goes through the queue first,
  // so open in the queued view — never flash the progress bar early.
  if (/^starting\b/i.test(n) || /^requesting\b/i.test(n) || /^working\b/i.test(n)) {
    return "in_line";
  }
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

/**
 * Replicate can cancel the remote prediction. Blue and Parascene only stop
 * the local waiter — the GPU job stays in line.
 */
export function generationRemoteCancelSupported(
  provider: string | null | undefined,
): boolean {
  return String(provider ?? "").trim().toLowerCase() === "replicate";
}

/** Keep the last known place while still in line — polls often omit it. */
export function stickyGpuWaitNote(
  previous: string | null | undefined,
  next: string | null | undefined,
): string {
  const n = String(next ?? "").trim();
  const prev = String(previous ?? "").trim();
  const nextPhase = gpuWaitPhaseFromNote(n) ?? gpuWaitPhaseFromStatus(n);
  if (nextPhase === "generating" || nextPhase === "timed_out") {
    return n || gpuWaitTitle(nextPhase);
  }
  const nextPlace = gpuWaitPlaceFromNote(n);
  const prevPlace = gpuWaitPlaceFromNote(prev);
  const inLine =
    nextPhase === "in_line" ||
    isGpuWaitInLine(n) ||
    (!n && isGpuWaitInLine(prev));
  if (inLine && !nextPlace && prevPlace) {
    return `QUEUED · ${prevPlace}`;
  }
  return n || prev;
}

/** Blue progress events sometimes send status (`pending`) instead of QUEUED. */
export function gpuWaitNoteFromBlueEvent(
  message: string | null | undefined,
  status: string | null | undefined,
  previous: string | null | undefined,
): string {
  const msg = String(message ?? "").trim();
  if (gpuWaitPhaseFromNote(msg) || gpuWaitPlaceFromNote(msg)) {
    return stickyGpuWaitNote(previous, msg);
  }
  const phase = gpuWaitPhaseFromStatus(status);
  if (phase === "generating") {
    return stickyGpuWaitNote(previous, gpuWaitTitle("generating"));
  }
  if (phase === "in_line") {
    return stickyGpuWaitNote(previous, gpuWaitTitle("in_line"));
  }
  if (msg) return stickyGpuWaitNote(previous, msg);
  return stickyGpuWaitNote(previous, previous || gpuWaitTitle("in_line"));
}
