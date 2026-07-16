import { describe, expect, it } from "vitest";
import {
  applyDraftToTimelineClip,
  defaultStagedClipDraft,
  formatStagedDuration,
  isProvisionalOutSec,
  parseStagedClipPayload,
  remapTrimForReverse,
  serializeStagedClip,
  stagedClipDuration,
  targetLaneForDraft,
  timelineClipToStagedDraft,
} from "./stagedClip";

describe("stagedClip", () => {
  it("builds defaults by kind", () => {
    const image = defaultStagedClipDraft({
      assetId: "a1",
      label: "Logo",
      kind: "image",
    });
    expect(stagedClipDuration(image)).toBe(10);

    const video = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 12.5,
    });
    expect(video.outSec).toBe(12.5);
    expect(video.includeAudio).toBe(false);
    expect(targetLaneForDraft(video)).toBe("video");
  });

  it("marks Out as provisional until source duration is known", () => {
    const pending = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
    });
    expect(pending.outSec).toBe(10);
    expect(isProvisionalOutSec(pending)).toBe(true);

    const known = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 42.5,
    });
    expect(known.outSec).toBe(42.5);
    expect(isProvisionalOutSec(known)).toBe(false);
  });

  it("serializes and parses drag payload", () => {
    const draft = defaultStagedClipDraft({
      assetId: "a1",
      label: "Clip",
      kind: "audio",
      sourceDurationSec: 20,
    });
    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.assetId).toBe("a1");
    expect(parsed?.kind).toBe("audio");
    expect(targetLaneForDraft(parsed!)).toBe("audio");
  });

  it("formats duration labels", () => {
    expect(formatStagedDuration(3)).toBe("0:03");
    expect(formatStagedDuration(65)).toBe("1:05");
  });

  it("maps timeline clip settings into a staged draft", () => {
    const draft = timelineClipToStagedDraft({
      assetId: "a1",
      label: "3.0s",
      kind: "image",
      startSec: 2,
      endSec: 5,
      inSec: 0,
      outSec: 3,
      includeAudio: false,
      transform: "kenBurns",
      framing: "fill",
      thumbUrl: "asset://thumb",
    });
    expect(draft).toMatchObject({
      assetId: "a1",
      kind: "image",
      inSec: 0,
      outSec: 3,
      transform: "kenBurns",
      framing: "fill",
      thumbUrl: "asset://thumb",
    });
    expect(timelineClipToStagedDraft({ label: "x", startSec: 0, endSec: 1 })).toBeNull();
  });

  it("treats audio-lane clips as audio (no include-audio)", () => {
    const draft = timelineClipToStagedDraft({
      assetId: "a1",
      label: "4.0s",
      lane: "audio",
      startSec: 0,
      endSec: 4,
    });
    expect(draft?.kind).toBe("audio");
    expect(draft?.includeAudio).toBe(false);
  });

  it("applies draft edits back onto a timeline clip", () => {
    const clip = {
      id: "c1",
      label: "3.0s",
      startSec: 5,
      endSec: 8,
      assetId: "a1",
      kind: "image" as const,
      inSec: 0,
      outSec: 3,
      includeAudio: false,
      transform: "hold" as const,
      framing: "fit" as const,
      thumbUrl: null,
    };
    const draft = defaultStagedClipDraft({
      assetId: "a1",
      label: "Logo",
      kind: "image",
    });
    draft.outSec = 5;
    draft.transform = "kenBurns";
    draft.framing = "fill";
    const next = applyDraftToTimelineClip(clip, draft);
    expect(next.startSec).toBe(5);
    expect(next.endSec).toBe(10);
    expect(next.transform).toBe("kenBurns");
    expect(next.framing).toBe("fill");
    expect(next.label).toBe("5.0s");
  });

  it("round-trips reverse on staged payloads", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.reverse = true;
    draft.inSec = 2;
    draft.outSec = 6;
    const parsed = parseStagedClipPayload(serializeStagedClip(draft));
    expect(parsed?.reverse).toBe(true);

    const clip = applyDraftToTimelineClip(
      {
        id: "c1",
        label: "4.0s",
        startSec: 0,
        endSec: 4,
        assetId: "v1",
        kind: "video",
      },
      draft,
    );
    expect(clip.reverse).toBe(true);
    expect(timelineClipToStagedDraft(clip)?.reverse).toBe(true);
  });

  it("mirrors in/out when toggling reverse", () => {
    const draft = defaultStagedClipDraft({
      assetId: "v1",
      label: "Take",
      kind: "video",
      sourceDurationSec: 10,
    });
    draft.inSec = 2;
    draft.outSec = 5;
    expect(remapTrimForReverse(draft, 10)).toEqual({ inSec: 5, outSec: 8 });
  });
});
