import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineClip } from "../../project/types";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("../../library/catalogClient", () => ({
  getCreations: vi.fn(),
  ensureClipThumb: vi.fn(),
  downloadIds: vi.fn(),
  ensureReversed: vi.fn(),
}));

vi.mock("../../lab/audioTools", () => ({
  applyImageFraming: vi.fn(),
  extractVideoFrame: vi.fn(),
}));

vi.mock("./uiOpTrace", () => ({
  recordUiOpTrace: vi.fn(),
}));

import { getCreations, ensureClipThumb } from "../../library/catalogClient";
import {
  resolveAddAssetBridgeFramesFromSources,
  startFrameIsReady,
} from "./addAssetStartFrame";

function clip(
  partial: Partial<TimelineClip> &
    Pick<TimelineClip, "id" | "startSec" | "endSec">,
): TimelineClip {
  return {
    label: partial.label ?? partial.id,
    lane: partial.lane ?? "video",
    kind: partial.kind ?? "video",
    assetId: partial.assetId ?? "asset-1",
    ...partial,
  };
}

describe("resolveAddAssetBridgeFramesFromSources", () => {
  beforeEach(() => {
    vi.mocked(getCreations).mockReset();
    vi.mocked(ensureClipThumb).mockReset();
    vi.mocked(ensureClipThumb).mockImplementation(async (id: string) => {
      return `/tmp/thumb-${id}.jpg`;
    });
  });

  it("resolves mixed asset first + timeline last without a prior clip", async () => {
    vi.mocked(getCreations).mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        mediaType: id === "img-first" ? "image" : "video",
        localPath: `/tmp/${id}.jpg`,
        name: id,
      })) as never,
    );

    const placeholder = clip({
      id: "gap",
      startSec: 0,
      endSec: 4,
      isAddAssetPlaceholder: true,
      assetId: "",
    });
    const next = clip({
      id: "next",
      startSec: 4,
      endSec: 12,
      assetId: "vid-next",
    });

    const bridge = await resolveAddAssetBridgeFramesFromSources(
      [placeholder, next],
      placeholder,
      "16:9",
      {
        firstFrameSource: { kind: "asset", assetId: "img-first" },
        lastFrameSource: { kind: "timeline" },
      },
    );

    expect(bridge).not.toBeNull();
    expect(startFrameIsReady(bridge!.first)).toBe(true);
    expect(startFrameIsReady(bridge!.last)).toBe(true);
    expect(bridge!.first.sourceAssetId).toBe("img-first");
    expect(bridge!.first.framePath).toContain("img-first");
    expect(bridge!.last.framePath).toContain("vid-next");
  });

  it("returns null when first is timeline and there is no prior clip", async () => {
    vi.mocked(getCreations).mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        mediaType: "video",
        localPath: `/tmp/${id}.mp4`,
        name: id,
      })) as never,
    );

    const placeholder = clip({
      id: "gap",
      startSec: 0,
      endSec: 4,
      isAddAssetPlaceholder: true,
      assetId: "",
    });
    const next = clip({
      id: "next",
      startSec: 4,
      endSec: 12,
      assetId: "vid-next",
    });

    const bridge = await resolveAddAssetBridgeFramesFromSources(
      [placeholder, next],
      placeholder,
      "16:9",
      {
        firstFrameSource: { kind: "timeline" },
        lastFrameSource: { kind: "timeline" },
      },
    );

    expect(bridge).toBeNull();
  });

  it("migrates legacy startFrameAssetId when firstFrameSource is omitted", async () => {
    vi.mocked(getCreations).mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        mediaType: id.startsWith("img") ? "image" : "video",
        localPath: `/tmp/${id}.jpg`,
        name: id,
      })) as never,
    );

    const prior = clip({
      id: "prior",
      startSec: 0,
      endSec: 4,
      assetId: "vid-prior",
    });
    const placeholder = clip({
      id: "gap",
      startSec: 4,
      endSec: 8,
      isAddAssetPlaceholder: true,
      assetId: "",
    });
    const next = clip({
      id: "next",
      startSec: 8,
      endSec: 16,
      assetId: "vid-next",
    });

    const bridge = await resolveAddAssetBridgeFramesFromSources(
      [prior, placeholder, next],
      placeholder,
      "16:9",
      {
        startFrameAssetId: "img-legacy",
        lastFrameSource: { kind: "timeline" },
      },
    );

    expect(bridge).not.toBeNull();
    expect(bridge!.first.sourceAssetId).toBe("img-legacy");
    expect(bridge!.last.framePath).toContain("vid-next");
  });
});
