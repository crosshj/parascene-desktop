import { describe, expect, it } from "vitest";
import {
  fmp4BaseMediaDecodeTime,
  fmp4HasMediaFragment,
  fmp4TfdtSec,
  formatTrackRange,
  inspectFragmentTimestamps,
  iterateMp4Boxes,
  splitFmp4,
} from "./fmp4Boxes";

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("splitFmp4", () => {
  it("separates init boxes from media fragments", () => {
    const data = join([
      box("ftyp", new Uint8Array([1, 2])),
      box("moov", new Uint8Array([3])),
      box("moof", new Uint8Array([4, 5])),
      box("mdat", new Uint8Array([6, 7, 8])),
    ]);
    const { init, media } = splitFmp4(data);
    expect(iterateMp4Boxes(init).map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(iterateMp4Boxes(media).map((b) => b.type)).toEqual(["moof", "mdat"]);
    expect(fmp4HasMediaFragment(data)).toBe(true);
  });

  it("reports a non-fragmented file as having no moof", () => {
    const data = join([
      box("ftyp", new Uint8Array([1])),
      box("moov", new Uint8Array([2])),
      box("mdat", new Uint8Array([3])),
    ]);
    expect(fmp4HasMediaFragment(data)).toBe(false);
  });
});

describe("fmp4BaseMediaDecodeTime", () => {
  it("reads tfdt ticks from a nested moof/traf", () => {
    const tfdt = box("tfdt", new Uint8Array([0, 0, 0, 0, 0, 0, 0x4e, 0x20]));
    const traf = box("traf", tfdt);
    const moof = box("moof", traf);
    expect(fmp4BaseMediaDecodeTime(moof)).toBe(0x4e20);
    expect(fmp4TfdtSec(moof, 10000)).toBe(2);
  });

  it("reports video and audio decode ranges independently", () => {
    const tfhd = box(
      "tfhd",
      new Uint8Array([0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 3, 232]),
    );
    const tfdt = box("tfdt", new Uint8Array([0, 0, 0, 0, 0, 0, 0x4e, 0x20]));
    const trun = box("trun", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 20]));
    const traf = box("traf", join([tfhd, tfdt, trun]));
    const moof = box("moof", traf);
    const report = inspectFragmentTimestamps(moof);
    expect(report.audio).toBeNull();
    expect(report.video?.startSec).toBe(2);
    expect(report.video?.endSec).toBe(4);
    expect(report.video?.sampleCount).toBe(20);
    expect(formatTrackRange(report.audio)).toBe("none");
    expect(formatTrackRange(report.video)).toContain("[2.000, 4.000]");
  });

  it("uses each track's own timescale for video vs audio", () => {
    const trak = (
      id: number,
      handler: string,
      timescale: number,
    ): Uint8Array => {
      const idBytes = new Uint8Array(16);
      idBytes[15] = id;
      const mdhd = new Uint8Array(16);
      mdhd[12] = (timescale >> 24) & 0xff;
      mdhd[13] = (timescale >> 16) & 0xff;
      mdhd[14] = (timescale >> 8) & 0xff;
      mdhd[15] = timescale & 0xff;
      const hdlr = new Uint8Array(12);
      hdlr[8] = handler.charCodeAt(0);
      hdlr[9] = handler.charCodeAt(1);
      hdlr[10] = handler.charCodeAt(2);
      hdlr[11] = handler.charCodeAt(3);
      const mdia = box("mdia", join([box("hdlr", hdlr), box("mdhd", mdhd)]));
      return box("trak", join([box("tkhd", idBytes), mdia]));
    };
    const init = box("moov", join([trak(1, "vide", 10000), trak(2, "soun", 48000)]));
    const videoTraf = box(
      "traf",
      join([
        box("tfhd", new Uint8Array([0, 0, 0, 8, 0, 0, 0, 1, 0, 0, 3, 232])),
        box("tfdt", new Uint8Array([0, 0, 0, 0, 0, 0, 0x4e, 0x20])),
        box("trun", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 20])),
      ]),
    );
    const audioTfdt = new Uint8Array(8);
    new DataView(audioTfdt.buffer).setUint32(4, 96000);
    const audioDur = new Uint8Array(12);
    audioDur[3] = 8;
    audioDur[7] = 2;
    audioDur[10] = 0x12;
    audioDur[11] = 0xc0;
    const audioTraf = box(
      "traf",
      join([
        box("tfhd", audioDur),
        box("tfdt", audioTfdt),
        box("trun", new Uint8Array([0, 0, 0, 0, 0, 0, 0, 20])),
      ]),
    );
    const file = join([box("ftyp", new Uint8Array([1])), init, box("moof", join([videoTraf, audioTraf]))]);
    const report = inspectFragmentTimestamps(file);
    expect(report.video?.timescale).toBe(10000);
    expect(report.video?.startSec).toBe(2);
    expect(report.video?.endSec).toBe(4);
    expect(report.audio?.timescale).toBe(48000);
    expect(report.audio?.startSec).toBe(2);
    expect(report.audio?.endSec).toBe(4);
  });
});
