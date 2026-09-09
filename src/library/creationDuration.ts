import { creationDetailUrl } from "./previewUrl";
import type { Creation } from "./types";

function finitePositive(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function durationFromRecord(row: Record<string, unknown> | null): number | null {
  if (!row) return null;
  return (
    finitePositive(row.duration) ??
    finitePositive(row.duration_sec) ??
    finitePositive(row.durationSec) ??
    finitePositive(row.duration_seconds)
  );
}

/** Catalog duration when Parascene / import meta already stamped it. */
export function durationSecFromCreation(
  creation: Pick<Creation, "remoteJson"> | null | undefined,
): number | null {
  const raw = creation?.remoteJson?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const meta =
      parsed.meta && typeof parsed.meta === "object"
        ? (parsed.meta as Record<string, unknown>)
        : null;
    const audio =
      (meta?.audio && typeof meta.audio === "object"
        ? (meta.audio as Record<string, unknown>)
        : null) ??
      (parsed.audio && typeof parsed.audio === "object"
        ? (parsed.audio as Record<string, unknown>)
        : null);
    return (
      durationFromRecord(audio) ??
      durationFromRecord(parsed) ??
      durationFromRecord(meta)
    );
  } catch {
    return null;
  }
}

/** Short chip: `4.2s`, `12s`, `1:12`, `1:05:03`. */
export function formatAudioDurationChip(sec: number): string | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) {
    const tenths = Math.round(sec * 10) / 10;
    return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
  }
  const total = Math.round(sec);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const probedDurationSec = new Map<string, number>();
const inflightDuration = new Map<string, Promise<number | null>>();

function probeKey(creation: Pick<Creation, "id" | "localPath" | "updatedAt">): string {
  return `${creation.id}\0${creation.localPath ?? ""}\0${creation.updatedAt}`;
}

function loadHtmlAudioDuration(url: string): Promise<number | null> {
  if (typeof Audio === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const el = new Audio();
    el.preload = "metadata";
    let settled = false;
    const finish = (sec: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(sec);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 && d !== Infinity ? d : null);
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}

/** Stamped catalog duration, else a one-shot metadata probe of the local file. */
export function probeCreationAudioDuration(
  creation: Creation,
): Promise<number | null> {
  const stamped = durationSecFromCreation(creation);
  if (stamped) return Promise.resolve(stamped);
  const key = probeKey(creation);
  const cached = probedDurationSec.get(key);
  if (cached) return Promise.resolve(cached);
  const url = creationDetailUrl(creation);
  if (!url) return Promise.resolve(null);
  const existing = inflightDuration.get(key);
  if (existing) return existing;
  const pending = loadHtmlAudioDuration(url).then((sec) => {
    inflightDuration.delete(key);
    if (sec) probedDurationSec.set(key, sec);
    return sec;
  });
  inflightDuration.set(key, pending);
  return pending;
}
