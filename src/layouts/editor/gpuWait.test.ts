import { describe, expect, it } from "vitest";
import {
  gpuWaitPhaseFromNote,
  gpuWaitPhaseFromStatus,
  gpuWaitPlaceFromNote,
  gpuWaitPlaceLine,
  gpuWaitTitle,
  isGpuWaitInLine,
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
    expect(isGpuWaitInLine("Working…")).toBe(false);
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
  });
});
