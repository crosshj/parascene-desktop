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

const NESTED_BOXES = new Set([
  "moof",
  "traf",
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
]);

function findBoxPayload(data: Uint8Array, type: string): Uint8Array | null {
  for (const box of iterateMp4Boxes(data)) {
    const payload = data.subarray(box.start + 8, box.start + box.size);
    if (box.type === type) return payload;
    if (NESTED_BOXES.has(box.type)) {
      const found = findBoxPayload(payload, type);
      if (found) return found;
    }
  }
  return null;
}

/** Raw tfdt baseMediaDecodeTime in media timescale ticks. */
export function fmp4BaseMediaDecodeTime(data: Uint8Array): number | null {
  const payload = findBoxPayload(data, "tfdt");
  if (!payload || payload.byteLength < 8) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = payload[0]!;
  if (version === 1) {
    if (payload.byteLength < 12) return null;
    return Number(view.getBigUint64(4));
  }
  return view.getUint32(4);
}

/** mdhd timescale, or null if the init has none. */
export function fmp4Timescale(data: Uint8Array): number | null {
  const payload = findBoxPayload(data, "mdhd");
  if (!payload || payload.byteLength < 16) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = payload[0]!;
  if (version === 1) {
    if (payload.byteLength < 24) return null;
    return view.getUint32(20);
  }
  return view.getUint32(12);
}

export function fmp4TfdtSec(data: Uint8Array, timescale = 10000): number | null {
  const ticks = fmp4BaseMediaDecodeTime(data);
  if (ticks == null || timescale <= 0) return null;
  return ticks / timescale;
}

export type MediaTrackKind = "video" | "audio" | "unknown";

export type TrackTimestampRange = {
  kind: MediaTrackKind;
  trackId: number;
  timescale: number;
  startTicks: number;
  endTicks: number;
  startSec: number;
  endSec: number;
  sampleCount: number;
};

export type FragmentTimestampReport = {
  video: TrackTimestampRange | null;
  audio: TrackTimestampRange | null;
};

type TrackMeta = {
  kind: MediaTrackKind;
  timescale: number;
};

function readAscii(data: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + len));
}

function parseTkhdId(payload: Uint8Array): number | null {
  if (payload.byteLength < 16) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = payload[0]!;
  if (version === 1) {
    if (payload.byteLength < 24) return null;
    return view.getUint32(20);
  }
  return view.getUint32(12);
}

function parseHdlrKind(payload: Uint8Array): MediaTrackKind {
  if (payload.byteLength < 12) return "unknown";
  const type = readAscii(payload, 8, 4);
  if (type === "vide") return "video";
  if (type === "soun") return "audio";
  return "unknown";
}

function parseMdhdTimescale(payload: Uint8Array): number | null {
  if (payload.byteLength < 16) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = payload[0]!;
  if (version === 1) {
    if (payload.byteLength < 24) return null;
    return view.getUint32(20);
  }
  return view.getUint32(12);
}

function trackMetasFromInit(init: Uint8Array): Map<number, TrackMeta> {
  const metas = new Map<number, TrackMeta>();
  for (const box of iterateMp4Boxes(init)) {
    if (box.type !== "moov") continue;
    const moov = init.subarray(box.start + 8, box.start + box.size);
    for (const trakBox of iterateMp4Boxes(moov)) {
      if (trakBox.type !== "trak") continue;
      const trak = moov.subarray(trakBox.start + 8, trakBox.start + trakBox.size);
      let id: number | null = null;
      let kind: MediaTrackKind = "unknown";
      let timescale: number | null = null;
      const walk = (data: Uint8Array) => {
        for (const child of iterateMp4Boxes(data)) {
          const payload = data.subarray(child.start + 8, child.start + child.size);
          if (child.type === "tkhd") id = parseTkhdId(payload);
          else if (child.type === "hdlr") kind = parseHdlrKind(payload);
          else if (child.type === "mdhd") timescale = parseMdhdTimescale(payload);
          if (NESTED_BOXES.has(child.type) || child.type === "mdia") {
            walk(payload);
          }
        }
      };
      walk(trak);
      if (id != null && timescale != null && timescale > 0) {
        metas.set(id, { kind, timescale });
      }
    }
  }
  return metas;
}

function parseTfhd(payload: Uint8Array): {
  trackId: number;
  defaultSampleDuration: number;
} | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint32(0) & 0xffffff;
  const trackId = view.getUint32(4);
  let offset = 8;
  if (flags & 0x1) offset += 8;
  if (flags & 0x2) offset += 4;
  let defaultSampleDuration = 0;
  if (flags & 0x8) {
    if (offset + 4 > payload.byteLength) return { trackId, defaultSampleDuration: 0 };
    defaultSampleDuration = view.getUint32(offset);
  }
  return { trackId, defaultSampleDuration };
}

function parseTfdtTicks(payload: Uint8Array): number | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const version = payload[0]!;
  if (version === 1) {
    if (payload.byteLength < 12) return null;
    return Number(view.getBigUint64(4));
  }
  return view.getUint32(4);
}

function parseTrunDuration(
  payload: Uint8Array,
  defaultSampleDuration: number,
): { sampleCount: number; durationTicks: number } | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const flags = view.getUint32(0) & 0xffffff;
  const sampleCount = view.getUint32(4);
  let offset = 8;
  if (flags & 0x1) offset += 4;
  if (flags & 0x4) offset += 4;
  const hasDuration = (flags & 0x100) !== 0;
  let durationTicks = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    if (hasDuration) {
      if (offset + 4 > payload.byteLength) break;
      durationTicks += view.getUint32(offset);
      offset += 4;
    } else {
      durationTicks += defaultSampleDuration;
    }
    if (flags & 0x200) offset += 4;
    if (flags & 0x400) offset += 4;
    if (flags & 0x800) offset += 4;
  }
  return { sampleCount, durationTicks };
}

function parseTraf(
  payload: Uint8Array,
  metas: Map<number, TrackMeta>,
): TrackTimestampRange | null {
  let trackId = 1;
  let defaultSampleDuration = 0;
  let startTicks: number | null = null;
  let sampleCount = 0;
  let durationTicks = 0;
  for (const child of iterateMp4Boxes(payload)) {
    const body = payload.subarray(child.start + 8, child.start + child.size);
    if (child.type === "tfhd") {
      const tfhd = parseTfhd(body);
      if (tfhd) {
        trackId = tfhd.trackId;
        defaultSampleDuration = tfhd.defaultSampleDuration;
      }
    } else if (child.type === "tfdt") {
      startTicks = parseTfdtTicks(body);
    } else if (child.type === "trun") {
      const trun = parseTrunDuration(body, defaultSampleDuration);
      if (trun) {
        sampleCount += trun.sampleCount;
        durationTicks += trun.durationTicks;
      }
    }
  }
  if (startTicks == null) return null;
  const meta = metas.get(trackId);
  const timescale = meta?.timescale && meta.timescale > 0 ? meta.timescale : 10000;
  const kind = meta?.kind ?? (trackId === 1 ? "video" : "unknown");
  const endTicks = startTicks + durationTicks;
  return {
    kind,
    trackId,
    timescale,
    startTicks,
    endTicks,
    startSec: startTicks / timescale,
    endSec: endTicks / timescale,
    sampleCount,
  };
}

/** Video and audio decode ranges from init + moof, using each track's own timescale. */
export function inspectFragmentTimestamps(
  data: Uint8Array,
): FragmentTimestampReport {
  const { init, media } = splitFmp4(data);
  const metas = trackMetasFromInit(init);
  const tracks: TrackTimestampRange[] = [];
  for (const box of iterateMp4Boxes(media.byteLength ? media : data)) {
    if (box.type !== "moof") continue;
    const moof = (media.byteLength ? media : data).subarray(
      box.start + 8,
      box.start + box.size,
    );
    for (const child of iterateMp4Boxes(moof)) {
      if (child.type !== "traf") continue;
      const traf = parseTraf(
        moof.subarray(child.start + 8, child.start + child.size),
        metas,
      );
      if (traf) tracks.push(traf);
    }
  }
  return {
    video: tracks.find((track) => track.kind === "video") ?? null,
    audio: tracks.find((track) => track.kind === "audio") ?? null,
  };
}

export function formatTrackRange(track: TrackTimestampRange | null): string {
  if (!track) return "none";
  return `[${track.startSec.toFixed(3)}, ${track.endSec.toFixed(3)}] ${track.sampleCount} samples timescale=${track.timescale}`;
}
