import { gpuWaitTitle, type GpuWaitPhase } from "./gpuWait";

const CLOCK_PATHS = (
  <>
    <circle cx="12" cy="12" r="6" />
    <polyline points="12 10 12 12 13.5 13" />
    <path d="m16.13 7.66-.81-1.41a2 2 0 0 0-1.74-1h-3.16a2 2 0 0 0-1.74 1l-.81 1.41" />
    <path d="m16.13 16.34-.81 1.41a2 2 0 0 1-1.74 1h-3.16a2 2 0 0 1-1.74-1l-.81-1.41" />
  </>
);

/** Upper-right wait mark: clock while queued, spinner while generating. */
export function GpuWaitBadge({
  phase,
  place,
}: {
  phase: Extract<GpuWaitPhase, "in_line" | "generating">;
  place?: number | null;
}) {
  if (phase === "in_line") {
    const label =
      gpuWaitTitle("in_line") + (place ? ` · ${place}` : "");
    return (
      <span
        className="editor-timeline-clip-bake is-queued"
        aria-label={label}
        title={
          place
            ? `${gpuWaitTitle("in_line")} · ${place}`
            : gpuWaitTitle("in_line")
        }
      >
        <svg
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {CLOCK_PATHS}
        </svg>
      </span>
    );
  }
  return (
    <span
      className="editor-timeline-clip-bake is-generating"
      aria-label={gpuWaitTitle("generating")}
    />
  );
}
