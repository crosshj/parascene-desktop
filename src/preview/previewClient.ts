import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TimelineClip } from "../project/types";

export type PreviewSessionInfo = {
  sessionId: string;
  codec: string;
};

export type PreviewStateEvent = {
  sessionId: string;
  playheadSec: number;
  playing: boolean;
  rate: number;
  durationSec: number;
  mode: string;
  generation: number;
};

export type FragmentReady = {
  sessionId: string;
  fragmentId: string;
  timelineStart: number;
  duration: number;
  /** Session-relative filenames for `preview_read_fragment`. */
  initFile: string;
  mediaFile: string;
  initPath: string;
  mediaPath: string;
  reset: boolean;
  mode: string;
  codec: string;
  generation: number;
};

export function timelineClipsToPreviewInput(clips: TimelineClip[]) {
  return clips.map((c) => ({
    id: c.id,
    label: c.label,
    startSec: c.startSec,
    endSec: c.endSec,
    assetId: c.assetId ?? null,
    lane: c.lane ?? null,
    kind: c.kind ?? null,
    inSec: c.inSec ?? null,
    outSec: c.outSec ?? null,
    includeAudio: c.includeAudio ?? null,
    reverse: c.reverse ?? null,
    transform: c.transform ?? null,
    framing: c.framing ?? null,
    bakePath: c.bakePath ?? null,
    bakeKey: c.bakeKey ?? null,
    transitionIn: c.transitionIn
      ? { kind: c.transitionIn.kind, durationSec: c.transitionIn.durationSec }
      : null,
    transitionOut: c.transitionOut
      ? { kind: c.transitionOut.kind, durationSec: c.transitionOut.durationSec }
      : null,
    effects: c.effects?.map((e) => ({ kind: e.kind, value: e.value })) ?? null,
  }));
}

export async function openPreviewSession(): Promise<PreviewSessionInfo> {
  return invoke<PreviewSessionInfo>("preview_session_open");
}

export async function closePreviewSession(sessionId: string): Promise<void> {
  await invoke("preview_session_close", { sessionId });
}

export async function setPreviewTimeline(
  sessionId: string,
  clips: TimelineClip[],
  aspectRatio: string,
  playheadSec?: number,
): Promise<void> {
  await invoke("preview_set_timeline", {
    input: {
      sessionId,
      clips: timelineClipsToPreviewInput(clips),
      aspectRatio,
      playheadSec: playheadSec ?? null,
    },
  });
}

export async function previewPlay(sessionId: string): Promise<void> {
  await invoke("preview_play", { sessionId });
}

export async function previewPause(sessionId: string): Promise<void> {
  await invoke("preview_pause", { sessionId });
}

export async function previewSeek(
  sessionId: string,
  playheadSec: number,
  mode: "playback" | "scrub" = "playback",
): Promise<void> {
  await invoke("preview_seek", {
    input: { sessionId, playheadSec, mode },
  });
}

export async function previewSetRate(sessionId: string, rate: number): Promise<void> {
  await invoke("preview_set_rate", { sessionId, rate });
}

export async function previewGetState(sessionId: string): Promise<PreviewStateEvent> {
  return invoke<PreviewStateEvent>("preview_get_state", { sessionId });
}

/**
 * Load fragment bytes. Prefer `media://` fetch (binary, fast); fall back to
 * IPC `number[]` when fetch fails (older WKWebView / race before file exists).
 */
export async function previewReadFragment(
  sessionId: string,
  file: string,
  absolutePath?: string | null,
): Promise<ArrayBuffer> {
  if (absolutePath) {
    try {
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const url = convertFileSrc(absolutePath, "media");
      const res = await fetch(url);
      if (res.ok) {
        return await res.arrayBuffer();
      }
    } catch {
      /* fall through to IPC */
    }
  }
  const bytes = await invoke<number[] | Uint8Array>("preview_read_fragment", {
    sessionId,
    file,
  });
  if (bytes instanceof Uint8Array) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }
  return Uint8Array.from(bytes).buffer;
}

export function listenPreviewState(
  cb: (ev: PreviewStateEvent) => void,
): Promise<UnlistenFn> {
  return listen<PreviewStateEvent>("preview-state", (e) => cb(e.payload));
}

export function listenFragmentReady(
  cb: (ev: FragmentReady) => void,
): Promise<UnlistenFn> {
  return listen<FragmentReady>("preview-fragment-ready", (e) => cb(e.payload));
}

export function listenPreviewError(
  cb: (ev: { sessionId: string; error: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ sessionId: string; error: string }>("preview-error", (e) =>
    cb(e.payload),
  );
}

export async function ensureProxies(creationId: string): Promise<void> {
  await invoke("library_ensure_proxies_async", { creationId });
}
