/** Detect contiguous vocal regions separated by silence on a waveform envelope. */

export type VocalBlock = {
  startSec: number;
  endSec: number;
};

const DEFAULT_ENERGY_RATIO = 0.1;
const DEFAULT_MIN_SILENCE_SEC = 0.4;
const DEFAULT_MIN_BLOCK_SEC = 0.3;
const DEFAULT_BLOCK_PAD_SEC = 0.1;

function roundSec(n: number): number {
  return Number(n.toFixed(3));
}

function vocalEnergyThreshold(
  peaks: number[],
  energyRatio = DEFAULT_ENERGY_RATIO,
): number {
  const globalMax = Math.max(...peaks, 1e-6);
  return globalMax * energyRatio;
}

/**
 * Split the timeline into vocal blocks at silence gaps.
 * Used to transcribe Whisper one sung phrase at a time.
 */
export function detectVocalBlocks(
  peaks: number[],
  durationSec: number,
  opts?: {
    energyRatio?: number;
    minSilenceSec?: number;
    minBlockSec?: number;
  },
): VocalBlock[] {
  if (!peaks.length || durationSec <= 0) return [];

  const threshold = vocalEnergyThreshold(peaks, opts?.energyRatio);
  const minSilenceSec = opts?.minSilenceSec ?? DEFAULT_MIN_SILENCE_SEC;
  const minBlockSec = opts?.minBlockSec ?? DEFAULT_MIN_BLOCK_SEC;
  const bucketSec = durationSec / peaks.length;
  const minSilentBuckets = Math.max(1, Math.ceil(minSilenceSec / bucketSec));

  const blocks: VocalBlock[] = [];
  let runStartBucket = -1;
  let silentBuckets = 0;

  const closeRun = (endBucket: number) => {
    if (runStartBucket < 0) return;
    const startSec = runStartBucket * bucketSec;
    const endSec = Math.min(durationSec, (endBucket + 1) * bucketSec);
    if (endSec - startSec >= minBlockSec) {
      blocks.push({ startSec: roundSec(startSec), endSec: roundSec(endSec) });
    }
    runStartBucket = -1;
    silentBuckets = 0;
  };

  for (let i = 0; i < peaks.length; i++) {
    const active = peaks[i] >= threshold;
    if (active) {
      if (runStartBucket < 0) runStartBucket = i;
      silentBuckets = 0;
      continue;
    }
    if (runStartBucket < 0) continue;
    silentBuckets += 1;
    if (silentBuckets >= minSilentBuckets) {
      closeRun(i - silentBuckets);
    }
  }

  if (runStartBucket >= 0) {
    closeRun(peaks.length - 1);
  }

  return blocks;
}

export function padVocalBlock(
  block: VocalBlock,
  durationSec: number,
  padSec = DEFAULT_BLOCK_PAD_SEC,
): VocalBlock {
  return {
    startSec: roundSec(Math.max(0, block.startSec - padSec)),
    endSec: roundSec(Math.min(durationSec, block.endSec + padSec)),
  };
}

export function vocalBlockCoverage(
  blocks: VocalBlock[],
  durationSec: number,
): number {
  if (durationSec <= 0) return 0;
  const vocalSec = blocks.reduce((sum, b) => sum + (b.endSec - b.startSec), 0);
  return vocalSec / durationSec;
}
