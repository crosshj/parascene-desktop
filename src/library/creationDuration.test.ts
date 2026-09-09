import { describe, expect, it } from "vitest";
import {
  durationSecFromCreation,
  formatAudioDurationChip,
} from "./creationDuration";

describe("durationSecFromCreation", () => {
  it("reads CDN meta.audio.duration", () => {
    expect(
      durationSecFromCreation({
        remoteJson: JSON.stringify({
          meta: { audio: { duration: 314.24 } },
        }),
      }),
    ).toBe(314.24);
  });

  it("ignores missing or invalid values", () => {
    expect(durationSecFromCreation({ remoteJson: null })).toBeNull();
    expect(durationSecFromCreation({ remoteJson: "{}" })).toBeNull();
    expect(
      durationSecFromCreation({
        remoteJson: JSON.stringify({ meta: { audio: { duration: 0 } } }),
      }),
    ).toBeNull();
  });
});

describe("formatAudioDurationChip", () => {
  it("uses a short seconds label under a minute", () => {
    expect(formatAudioDurationChip(4.2)).toBe("4.2s");
    expect(formatAudioDurationChip(8)).toBe("8s");
    expect(formatAudioDurationChip(12.04)).toBe("12s");
  });

  it("uses m:ss for longer clips", () => {
    expect(formatAudioDurationChip(72)).toBe("1:12");
    expect(formatAudioDurationChip(314.24)).toBe("5:14");
  });

  it("returns null when there is nothing to show", () => {
    expect(formatAudioDurationChip(0)).toBeNull();
    expect(formatAudioDurationChip(Number.NaN)).toBeNull();
  });
});
