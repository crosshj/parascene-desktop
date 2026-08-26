import { invoke } from "@tauri-apps/api/core";
import type { PreviewPlaybackStatus } from "./timelinePlaybackEngine";

export const PREVIEW_LOG_PREFIX = "[preview]";

export type PreviewDiagEvent = {
  ts: number;
  f?: string;
  fragment?: number;
  generation?: number;
  attempt?: number;
  phase: string;
  detail?: string;
};

const PREVIEW_EVENT_RING_MAX = 80;
const previewEventRing: PreviewDiagEvent[] = [];

function pushPreviewEvent(event: PreviewDiagEvent) {
  previewEventRing.push(event);
  if (previewEventRing.length > PREVIEW_EVENT_RING_MAX) {
    previewEventRing.splice(0, previewEventRing.length - PREVIEW_EVENT_RING_MAX);
  }
}

export function getPreviewDiagEvents(): readonly PreviewDiagEvent[] {
  return previewEventRing;
}

export function formatPreviewHealthReport(args: {
  previewStatus?: PreviewPlaybackStatus;
  fragmentStatus?: {
    ready: number;
    total: number;
    baking: boolean;
    queued?: number;
    error: string | null;
    playheadReady: boolean;
  };
}): string {
  const lines: string[] = [];
  const { previewStatus, fragmentStatus } = args;
  lines.push("Preview health");
  lines.push(`Time: ${new Date().toISOString()}`);
  if (previewStatus) {
    lines.push(`Phase: ${previewStatus.phase}`);
    lines.push(`Holding: ${previewStatus.holding ? "yes" : "no"}`);
    if (previewStatus.message) lines.push(`Message: ${previewStatus.message}`);
    if (previewStatus.retryable != null) {
      lines.push(`Retryable: ${previewStatus.retryable ? "yes" : "no"}`);
    }
  }
  if (fragmentStatus) {
    lines.push(
      `Cache: ${fragmentStatus.ready}/${fragmentStatus.total} ready` +
        (fragmentStatus.queued ? ` (${fragmentStatus.queued} queued)` : ""),
    );
    lines.push(`Baking: ${fragmentStatus.baking ? "yes" : "no"}`);
    lines.push(
      `Playhead disk-ready: ${fragmentStatus.playheadReady ? "yes" : "no"}`,
    );
    if (fragmentStatus.error) lines.push(`Cache error: ${fragmentStatus.error}`);
  }
  const events = getPreviewDiagEvents();
  if (events.length > 0) {
    lines.push("");
    lines.push("Recent events:");
    for (const event of events.slice(-24)) {
      const parts = [
        new Date(event.ts).toISOString(),
        event.f ? `[${event.f}]` : null,
        event.phase,
        event.detail,
        event.fragment != null ? `fragment=${event.fragment}` : null,
        event.generation != null ? `gen=${event.generation}` : null,
        event.attempt != null ? `attempt=${event.attempt}` : null,
      ].filter(Boolean);
      lines.push(`  ${parts.join(" ")}`);
    }
  }
  return lines.join("\n");
}

/** Mirror to console; persist T1+ transitions to Library/logs/preview.jsonl. */
export function logPreviewEvent(
  event: PreviewDiagEvent,
  persist = false,
): void {
  const stamped = { ...event, ts: event.ts || Date.now() };
  pushPreviewEvent(stamped);
  const line = `${PREVIEW_LOG_PREFIX} ${event.phase}${event.detail ? `: ${event.detail}` : ""}`;
  if (event.phase.includes("blocked") || event.phase.includes("error")) {
    console.warn(line, event);
  } else {
    console.info(line, event);
  }
  if (!persist) return;
  void invoke<string>("library_append_diag_log", {
    channel: "preview",
    payload: stamped,
  }).catch((error) => {
    console.warn(`${PREVIEW_LOG_PREFIX} could not write disk trace`, error);
  });
}
