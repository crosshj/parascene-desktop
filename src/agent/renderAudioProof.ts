/**
 * Dual-track render proof: A1 (generated speech) then a silent gap then A2.
 * If A2 never mixes, the third window is silent. If clips are concatenated
 * without the gap, the middle window has audio.
 */

export const RENDER_PROOF_GAP_SEC = 1.5;
export const RENDER_PROOF_INSET_SEC = 0.25;
export const RENDER_PROOF_LISTEN_SEC = 1;

/** Mean volume louder than this counts as speech in the mix. */
export const AUDIO_MEAN_DB_MIN = -40;
/** Mean volume quieter than this counts as a silent gap. */
export const SILENCE_MEAN_DB_MAX = -50;

export type ProofSpan = {
  startSec: number;
  endSec: number;
};

export type DualTrackProofLayout = {
  flash: ProofSpan;
  gap: ProofSpan;
  speech: ProofSpan;
};

export type ProofWindow = {
  id: "flash" | "gap" | "speech";
  startSec: number;
  durationSec: number;
  expect: "audio" | "silence";
};

export type VolumeReading = {
  meanDb: number;
  maxDb: number;
};

export function dualTrackProofLayout(opts: {
  flashDurationSec: number;
  speechDurationSec: number;
  gapSec?: number;
}): DualTrackProofLayout {
  const flashDurationSec = finitePositive(opts.flashDurationSec, "flashDurationSec");
  const speechDurationSec = finitePositive(opts.speechDurationSec, "speechDurationSec");
  const gapSec = opts.gapSec ?? RENDER_PROOF_GAP_SEC;
  if (!(gapSec > 0) || !Number.isFinite(gapSec)) {
    throw new Error("gapSec must be a positive duration");
  }
  const flashEnd = flashDurationSec;
  const speechStart = flashEnd + gapSec;
  return {
    flash: { startSec: 0, endSec: flashEnd },
    gap: { startSec: flashEnd, endSec: speechStart },
    speech: { startSec: speechStart, endSec: speechStart + speechDurationSec },
  };
}

export function proofWindows(layout: DualTrackProofLayout): ProofWindow[] {
  return [
    insetWindow("flash", layout.flash, "audio"),
    insetWindow("gap", layout.gap, "silence"),
    insetWindow("speech", layout.speech, "audio"),
  ];
}

export function parseVolumeDetect(stderr: string): VolumeReading {
  const meanDb = parseDbLine(stderr, /mean_volume:\s+([-\d.]+|inf|-inf)\s+dB/i);
  const maxDb = parseDbLine(stderr, /max_volume:\s+([-\d.]+|inf|-inf)\s+dB/i);
  if (meanDb === null || maxDb === null) {
    throw new Error(`volumedetect missing mean/max in:\n${stderr}`);
  }
  return { meanDb, maxDb };
}

export function classifyVolume(reading: VolumeReading): "audio" | "silence" | "uncertain" {
  if (reading.meanDb > AUDIO_MEAN_DB_MIN) return "audio";
  if (reading.meanDb < SILENCE_MEAN_DB_MAX) return "silence";
  return "uncertain";
}

export function assertProofWindow(
  window: ProofWindow,
  reading: VolumeReading,
): void {
  const got = classifyVolume(reading);
  if (got === window.expect) return;
  const label = `${window.id} ${window.startSec.toFixed(2)}s+${window.durationSec.toFixed(2)}s`;
  throw new Error(
    `${label}: expected ${window.expect}, got ${got} (mean ${reading.meanDb} dB, max ${reading.maxDb} dB)`,
  );
}

function insetWindow(
  id: ProofWindow["id"],
  span: ProofSpan,
  expect: ProofWindow["expect"],
): ProofWindow {
  const startSec = span.startSec + RENDER_PROOF_INSET_SEC;
  const endSec = Math.min(
    span.endSec - RENDER_PROOF_INSET_SEC,
    startSec + RENDER_PROOF_LISTEN_SEC,
  );
  const durationSec = endSec - startSec;
  if (durationSec < 0.4) {
    throw new Error(
      `${id} span ${span.startSec}–${span.endSec}s is too short for a ${expect} probe`,
    );
  }
  return { id, startSec, durationSec, expect };
}

function finitePositive(value: number, name: string): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${name} must be a positive duration`);
  }
  return value;
}

function parseDbLine(stderr: string, re: RegExp): number | null {
  const match = re.exec(stderr);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  if (raw === "-inf") return Number.NEGATIVE_INFINITY;
  if (raw === "inf") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
