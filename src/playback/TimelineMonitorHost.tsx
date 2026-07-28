import { useRef } from "react";
import {
  useTimelinePlaybackEngine,
  type TimelinePlaybackEngineHostProps,
} from "./useTimelinePlaybackEngine";

export type TimelineMonitorHostProps = TimelinePlaybackEngineHostProps;

/**
 * Thin React host for the imperative timeline playback engine.
 * While playing the engine owns the clock; React receives throttled onTimeUpdate.
 */
export function TimelineMonitorHost(props: TimelineMonitorHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTimelinePlaybackEngine(containerRef, props);

  return (
    <div
      ref={containerRef}
      className="timeline-playback-engine-host"
      style={{ width: "100%", height: "100%", position: "relative" }}
    />
  );
}
