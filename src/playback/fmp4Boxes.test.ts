import { describe, expect, it } from "vitest";
import { fmp4HasMediaFragment, iterateMp4Boxes, splitFmp4 } from "./fmp4Boxes";

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
