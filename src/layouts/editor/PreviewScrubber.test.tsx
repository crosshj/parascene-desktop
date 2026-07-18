import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewScrubber } from "./PreviewScrubber";

describe("PreviewScrubber", () => {
  it("renders In/Out handles only when trim is provided", () => {
    const { rerender } = render(
      <PreviewScrubber
        currentSec={2}
        durationSec={10}
        onSeek={vi.fn()}
        trim={null}
      />,
    );
    expect(screen.queryByRole("button", { name: "Set In point" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set Out point" })).toBeNull();

    rerender(
      <PreviewScrubber
        currentSec={2}
        durationSec={10}
        onSeek={vi.fn()}
        trim={{ inSec: 1, outSec: 8, onChange: vi.fn() }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Set In point" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Out point" }),
    ).toBeInTheDocument();
  });

  it("drags the In handle to update trim", () => {
    const onChange = vi.fn();
    const onSeek = vi.fn();
    render(
      <PreviewScrubber
        currentSec={0}
        durationSec={10}
        onSeek={onSeek}
        trim={{ inSec: 1, outSec: 8, onChange }}
      />,
    );

    const track = document.querySelector(".editor-preview-scrubber-track");
    expect(track).toBeTruthy();
    // Fake layout geometry so pointer → time mapping works in jsdom.
    vi.spyOn(track as HTMLElement, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 20,
      right: 200,
      width: 200,
      height: 20,
      toJSON: () => ({}),
    });

    const inHandle = screen.getByRole("button", { name: "Set In point" });
    fireEvent.pointerDown(inHandle, { clientX: 60, button: 0 });
    fireEvent.pointerMove(window, { clientX: 60 });
    fireEvent.pointerUp(window, { clientX: 60 });

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as {
      inSec: number;
      outSec: number;
    };
    expect(last.outSec).toBe(8);
    expect(last.inSec).toBeCloseTo(3, 0);
    expect(onSeek).toHaveBeenCalled();
  });
});
