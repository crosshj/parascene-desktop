import { describe, expect, it, vi } from "vitest";
import {
  createMseFragmentPlayer,
  timelineMseSupported,
} from "./mseFragmentPlayer";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (path: string) => `media://localhost/${encodeURIComponent(path)}`,
}));

describe("createMseFragmentPlayer", () => {
  it("mounts a single muted video element and tears it down", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    expect(host.querySelector("video")).toBeNull();
    player.show();
    expect(host.querySelector("video")).toBe(player.video);
    expect(player.video.muted).toBe(true);
    expect(player.isActive()).toBe(true);
    player.hide();
    expect(player.isActive()).toBe(false);
    expect(player.covers(0)).toBe(false);
    player.warm();
    expect(player.isActive()).toBe(false);
    expect(host.querySelector("video")).toBe(player.video);
    player.destroy();
    expect(host.querySelector("video")).toBeNull();
    host.remove();
  });

  it("reports MSE support without throwing", () => {
    expect(typeof timelineMseSupported()).toBe("boolean");
  });

  it("calls muted play() once the playhead range is buffered", () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.setDuration(10);
    player.show();
    Object.defineProperty(player.video, "currentTime", {
      configurable: true,
      value: 0.5,
    });
    Object.defineProperty(player.video, "buffered", {
      configurable: true,
      value: {
        length: 1,
        start: () => 0,
        end: () => 2,
      },
    });
    player.sync(0.5, true, [], { feed: false, seek: false });
    expect(play).toHaveBeenCalled();
    player.destroy();
    host.remove();
    play.mockRestore();
  });

  it("keeps a seek pending until the target range is buffered", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    player.sync(1.2, false, [], { feed: false, seek: true });
    expect(player.hasPendingSeek()).toBe(true);
    expect(player.getTime()).toBe(0);
    player.destroy();
    host.remove();
  });

  it("reports exact range coverage, not interior slop", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    expect(player.coversRangeExact(0, 2)).toBe(false);
    expect(player.appendedCount()).toBe(0);
    player.destroy();
    host.remove();
  });

  it("does not roll from a stale position while a seek waits for data", () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.show();
    player.sync(3, true, [], { feed: false, seek: true });
    expect(player.hasPendingSeek()).toBe(true);
    expect(play).not.toHaveBeenCalled();
    player.destroy();
    host.remove();
    play.mockRestore();
  });

  it("reports fragment fetch failures instead of swallowing them", async () => {
    const onFetchError = vi.fn();
    const fetchMock = vi.fn().mockRejectedValue(new Error("CSP blocked"));
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host, { onFetchError });
    player.show();
    player.warm();
    player.sync(
      0,
      false,
      [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          fingerprint: "abc",
          path: "/tmp/frag.mp4",
        },
      ],
      { feed: true },
    );
    await vi.waitFor(() => {
      expect(onFetchError).toHaveBeenCalled();
    });
    expect(String(onFetchError.mock.calls[0]?.[0]).length).toBeGreaterThan(0);
    player.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("signals missing fragments on fetch 404", async () => {
    const onFragmentMissing = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host, { onFragmentMissing });
    player.show();
    player.warm();
    player.sync(
      0,
      false,
      [
        {
          index: 0,
          startSec: 0,
          durationSec: 2,
          fingerprint: "abc",
          path: "/tmp/missing-frag.mp4",
        },
      ],
      { feed: true },
    );
    await vi.waitFor(() => {
      expect(onFragmentMissing).toHaveBeenCalledWith("/tmp/missing-frag.mp4");
    });
    player.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("rejects fragments whose tfdt does not match the plan start", async () => {
    const box = (type: string, payload: Uint8Array) => {
      const out = new Uint8Array(8 + payload.byteLength);
      const view = new DataView(out.buffer);
      view.setUint32(0, out.byteLength);
      out[4] = type.charCodeAt(0);
      out[5] = type.charCodeAt(1);
      out[6] = type.charCodeAt(2);
      out[7] = type.charCodeAt(3);
      out.set(payload, 8);
      return out;
    };
    const join = (parts: Uint8Array[]) => {
      const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    };
    // tfdt baseMediaDecodeTime = 0, but plan says startSec = 54.
    const tfdt = box("tfdt", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
    const trun = box("trun", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 60]));
    const traf = box("traf", join([tfdt, trun]));
    const moof = box("moof", traf);
    const ftyp = box("ftyp", new Uint8Array([1, 2, 3, 4]));
    const fragmentBytes = join([ftyp, moof]);

    const onFragmentMissing = vi.fn();
    const onFetchError = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fragmentBytes.buffer.slice(
          fragmentBytes.byteOffset,
          fragmentBytes.byteOffset + fragmentBytes.byteLength,
        ),
    });
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host, {
      onFragmentMissing,
      onFetchError,
    });
    player.show();
    player.warm();
    player.sync(
      54,
      false,
      [
        {
          index: 27,
          startSec: 54,
          durationSec: 2,
          fingerprint: "bad-tfdt",
          path: "/tmp/frag-27-bad.mp4",
        },
      ],
      { feed: true },
    );
    await vi.waitFor(() => {
      expect(onFragmentMissing).toHaveBeenCalledWith("/tmp/frag-27-bad.mp4");
    });
    expect(onFetchError.mock.calls.some((call) =>
      String(call[0]).includes("timestamps"),
    )).toBe(true);
    player.destroy();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("discards stale generation work", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const player = createMseFragmentPlayer(host);
    player.warm();
    player.setGeneration(1);
    player.setGeneration(2);
    expect(player.getPreviewPhase()).not.toBe("blocked");
    player.destroy();
    host.remove();
  });
});
