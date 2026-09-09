import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assertProofWindow,
  parseVolumeDetect,
  type ProofWindow,
  type VolumeReading,
} from "../src/agent/renderAudioProof";

const execFileAsync = promisify(execFile);

export async function measureRenderWindow(
  renderPath: string,
  window: Pick<ProofWindow, "startSec" | "durationSec">,
): Promise<VolumeReading> {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-ss",
      window.startSec.toFixed(3),
      "-t",
      window.durationSec.toFixed(3),
      "-i",
      renderPath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    { timeout: 30_000 },
  );
  return parseVolumeDetect(stderr);
}

export async function assertRenderProofWindows(
  renderPath: string,
  windows: ProofWindow[],
): Promise<VolumeReading[]> {
  const readings: VolumeReading[] = [];
  for (const window of windows) {
    const reading = await measureRenderWindow(renderPath, window);
    assertProofWindow(window, reading);
    readings.push(reading);
  }
  return readings;
}
