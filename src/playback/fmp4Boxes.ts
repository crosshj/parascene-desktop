export type Mp4Box = {
  type: string;
  start: number;
  size: number;
};

const INIT_BOXES = new Set(["ftyp", "moov", "pdin", "free", "skip"]);

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function iterateMp4Boxes(data: Uint8Array): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 8 <= data.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(
      data[offset + 4]!,
      data[offset + 5]!,
      data[offset + 6]!,
      data[offset + 7]!,
    );
    let header = 8;
    if (size === 1) {
      if (offset + 16 > data.byteLength) break;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = data.byteLength - offset;
    }
    if (size < header || offset + size > data.byteLength) break;
    boxes.push({ type, start: offset, size });
    offset += size;
  }
  return boxes;
}

export function splitFmp4(data: Uint8Array): {
  init: Uint8Array;
  media: Uint8Array;
} {
  const initParts: Uint8Array[] = [];
  const mediaParts: Uint8Array[] = [];
  for (const box of iterateMp4Boxes(data)) {
    const slice = data.subarray(box.start, box.start + box.size);
    if (INIT_BOXES.has(box.type)) initParts.push(slice);
    else mediaParts.push(slice);
  }
  return { init: concatBytes(initParts), media: concatBytes(mediaParts) };
}

export function fmp4HasMediaFragment(data: Uint8Array): boolean {
  return iterateMp4Boxes(data).some((box) => box.type === "moof");
}
