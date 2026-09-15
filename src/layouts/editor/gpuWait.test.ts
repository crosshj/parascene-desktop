import { describe, expect, it } from "vitest";
import {
  gpuWaitNoteFromBlueEvent,
  gpuWaitPhaseFromNote,
  gpuWaitPhaseFromStatus,
  gpuWaitPlaceFromNote,
  gpuWaitPlaceLine,
  gpuWaitTitle,
  generationRemoteCancelSupported,
  isGpuWaitInLine,
  stickyGpuWaitNote,
} from "./gpuWait";

describe("gpuWait", () => {
  it("maps www queued to queued and processing to generating", () => {
    expect(gpuWaitPhaseFromStatus("queued")).toBe("in_line");
    expect(gpuWaitPhaseFromStatus("creating")).toBe("in_line");
    expect(gpuWaitPhaseFromStatus("processing")).toBe("generating");
    expect(gpuWaitPhaseFromStatus("running")).toBe("generating");
    expect(gpuWaitPhaseFromStatus("timed_out")).toBe("timed_out");
    expect(gpuWaitPhaseFromStatus("complete")).toBeNull();
  });

  it("uses the same status lines as www", () => {
    expect(gpuWaitTitle("in_line")).toBe("QUEUED");
    expect(gpuWaitTitle("generating")).toBe("Generating…");
    expect(gpuWaitTitle("timed_out")).toBe("TIMED OUT");
    expect(gpuWaitPhaseFromNote("QUEUED · 2")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("In line · 2")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Generating…")).toBe("generating");
    expect(gpuWaitPhaseFromNote("TIMED OUT")).toBe("timed_out");
    expect(isGpuWaitInLine("QUEUED")).toBe(true);
    expect(isGpuWaitInLine("In line")).toBe(true);
    // Startup notes open in the queued view — the progress bar must never
    // flash before the backend reports the job is actually generating.
    expect(isGpuWaitInLine("Working…")).toBe(true);
    expect(gpuWaitPhaseFromNote("Starting…")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Starting image generation on Parascene…")).toBe(
      "in_line",
    );
    expect(gpuWaitPhaseFromNote("Starting text-to-video…")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Requesting…")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Working…")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Waiting for 30086…")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Waiting for 30086 (queued)")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Waiting for 30086 (processing)")).toBe(
      "generating",
    );
    expect(gpuWaitPhaseFromNote("Waiting for Blue…")).toBe("in_line");
    expect(gpuWaitPlaceFromNote("QUEUED · 3")).toBe(3);
    expect(gpuWaitPlaceFromNote("In line · 3")).toBe(3);
    expect(gpuWaitPlaceFromNote("Waiting for 30086 (queued)")).toBeNull();
    expect(gpuWaitPlaceLine(3)).toBe("3 in line");
    expect(gpuWaitPhaseFromNote("pending")).toBe("in_line");
    expect(gpuWaitPhaseFromNote("Parascene is busy, still waiting for 12…")).toBe(
      "in_line",
    );
    expect(stickyGpuWaitNote("QUEUED · 1", "QUEUED")).toBe("QUEUED · 1");
    expect(stickyGpuWaitNote("QUEUED · 1", "Generating…")).toBe("Generating…");
    expect(gpuWaitNoteFromBlueEvent("", "pending", "QUEUED · 2")).toBe(
      "QUEUED · 2",
    );
    expect(gpuWaitNoteFromBlueEvent("QUEUED", "pending", "QUEUED · 2")).toBe(
      "QUEUED · 2",
    );
    expect(generationRemoteCancelSupported("replicate")).toBe(true);
    expect(generationRemoteCancelSupported("blue_direct")).toBe(false);
    expect(generationRemoteCancelSupported("parascene_blue")).toBe(false);
  });
});
