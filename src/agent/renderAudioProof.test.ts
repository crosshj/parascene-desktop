import { describe, expect, it } from "vitest";
import {
  assertProofWindow,
  AUDIO_MEAN_DB_MIN,
  classifyVolume,
  dualTrackProofLayout,
  parseVolumeDetect,
  proofWindows,
  RENDER_PROOF_GAP_SEC,
  SILENCE_MEAN_DB_MAX,
} from "./renderAudioProof";

describe("dualTrackProofLayout", () => {
  it("puts A2 after a silent gap so each window can fail independently", () => {
    const layout = dualTrackProofLayout({
      flashDurationSec: 2.4,
      speechDurationSec: 21,
    });
    expect(layout.flash).toEqual({ startSec: 0, endSec: 2.4 });
    expect(layout.gap.startSec).toBe(2.4);
    expect(layout.gap.endSec).toBe(2.4 + RENDER_PROOF_GAP_SEC);
    expect(layout.speech.startSec).toBe(2.4 + RENDER_PROOF_GAP_SEC);
    expect(layout.speech.endSec).toBe(2.4 + RENDER_PROOF_GAP_SEC + 21);
  });

  it("rejects empty clips", () => {
    expect(() =>
      dualTrackProofLayout({ flashDurationSec: 0, speechDurationSec: 2 }),
    ).toThrow(/flashDurationSec/);
  });
});

describe("proofWindows", () => {
  it("listens inside each span: audio, silence, audio", () => {
    const windows = proofWindows(
      dualTrackProofLayout({
        flashDurationSec: 2.4,
        speechDurationSec: 21,
      }),
    );
    expect(windows.map((w) => w.expect)).toEqual(["audio", "silence", "audio"]);
    expect(windows[0].startSec).toBeGreaterThan(0);
    expect(windows[0].startSec + windows[0].durationSec).toBeLessThan(2.4);
    expect(windows[1].startSec).toBeGreaterThanOrEqual(2.4);
    expect(windows[1].startSec + windows[1].durationSec).toBeLessThanOrEqual(
      2.4 + RENDER_PROOF_GAP_SEC,
    );
    expect(windows[2].startSec).toBeGreaterThan(2.4 + RENDER_PROOF_GAP_SEC);
  });

  it("refuses a clip too short to tell speech from an edge fade", () => {
    expect(() =>
      proofWindows(
        dualTrackProofLayout({
          flashDurationSec: 0.5,
          speechDurationSec: 21,
        }),
      ),
    ).toThrow(/too short/);
  });
});

describe("parseVolumeDetect", () => {
  it("reads mean and max from ffmpeg stderr", () => {
    const reading = parseVolumeDetect(`
[Parsed_volumedetect_0 @ 0x0] n_samples: 22050
[Parsed_volumedetect_0 @ 0x0] mean_volume: -22.4 dB
[Parsed_volumedetect_0 @ 0x0] max_volume: -4.1 dB
`);
    expect(reading.meanDb).toBeCloseTo(-22.4);
    expect(reading.maxDb).toBeCloseTo(-4.1);
  });

  it("treats digital silence as -inf", () => {
    const reading = parseVolumeDetect(
      "mean_volume: -inf dB\nmax_volume: -inf dB\n",
    );
    expect(reading.meanDb).toBe(Number.NEGATIVE_INFINITY);
    expect(reading.maxDb).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("classifyVolume", () => {
  it("separates speech from a silent gap with a dead band between", () => {
    expect(classifyVolume({ meanDb: -22, maxDb: -4 })).toBe("audio");
    expect(classifyVolume({ meanDb: -70, maxDb: -60 })).toBe("silence");
    expect(classifyVolume({ meanDb: Number.NEGATIVE_INFINITY, maxDb: Number.NEGATIVE_INFINITY })).toBe(
      "silence",
    );
    const mid = (AUDIO_MEAN_DB_MIN + SILENCE_MEAN_DB_MAX) / 2;
    expect(classifyVolume({ meanDb: mid, maxDb: mid })).toBe("uncertain");
  });

  it("fails a window that does not match what the mix should contain", () => {
    const flash = proofWindows(
      dualTrackProofLayout({ flashDurationSec: 2.4, speechDurationSec: 21 }),
    )[0];
    expect(() =>
      assertProofWindow(flash, { meanDb: -80, maxDb: -70 }),
    ).toThrow(/expected audio/);
  });
});
