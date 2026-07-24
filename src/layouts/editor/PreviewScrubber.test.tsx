import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PreviewScrubber } from "./PreviewScrubber";

function mockTrackGeometry() {
  const track = document.querySelector(".editor-preview-scrubber-track");
  expect(track).toBeTruthy();
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
  return track as HTMLElement;
}

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
        trim={{
          inSec: 1,
          outSec: 8,
          onLiveChange: vi.fn(),
          onCommit: vi.fn(),
        }}
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
    const onLiveChange = vi.fn();
    const onCommit = vi.fn();
    const onSeek = vi.fn();
    render(
      <PreviewScrubber
        currentSec={0}
        durationSec={10}
        onSeek={onSeek}
        trim={{ inSec: 1, outSec: 8, onLiveChange, onCommit }}
      />,
    );

    mockTrackGeometry();

    const inHandle = screen.getByRole("button", { name: "Set In point" });
    fireEvent.pointerDown(inHandle, { clientX: 60, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 60, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 60, pointerId: 1 });

    expect(onLiveChange).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0]?.[0] as {
      inSec: number;
      outSec: number;
    };
    expect(committed.outSec).toBe(8);
    expect(committed.inSec).toBeCloseTo(3, 0);
    expect(onSeek).toHaveBeenCalledWith(expect.any(Number), { trim: true });
  });

  it("prefers the In handle when the playhead sits on the same position", () => {
    const onLiveChange = vi.fn();
    const onCommit = vi.fn();
    const onSeek = vi.fn();
    render(
      <PreviewScrubber
        currentSec={1}
        durationSec={10}
        onSeek={onSeek}
        trim={{ inSec: 1, outSec: 8, onLiveChange, onCommit }}
      />,
    );

    const track = mockTrackGeometry();

    fireEvent.pointerDown(track, {
      clientX: 20,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 30, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 30, pointerId: 1 });

    expect(onLiveChange).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0]?.[0] as {
      inSec: number;
      outSec: number;
    };
    expect(committed.inSec).toBeGreaterThan(1);
    expect(committed.outSec).toBe(8);
    expect(onSeek).toHaveBeenCalledWith(expect.any(Number), { trim: true });
  });

  it("keeps dragging after parent re-render from onLiveChange", () => {
    const onLiveChange = vi.fn();
    const onCommit = vi.fn();
    const onSeek = vi.fn();
    const Wrapper = () => {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            rerender {tick}
          </button>
          <PreviewScrubber
            currentSec={0}
            durationSec={10}
            onSeek={(...args) => {
              onSeek(...args);
              setTick((n) => n + 1);
            }}
            trim={{
              inSec: 1,
              outSec: 8,
              onLiveChange: (next) => {
                onLiveChange(next);
                setTick((n) => n + 1);
              },
              onCommit,
            }}
          />
        </>
      );
    };

    render(<Wrapper />);
    mockTrackGeometry();

    const inHandle = screen.getByRole("button", { name: "Set In point" });
    fireEvent.pointerDown(inHandle, { clientX: 20, button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 80, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 80, pointerId: 1 });

    expect(onLiveChange.mock.calls.length).toBeGreaterThan(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
    const committed = onCommit.mock.calls[0]?.[0] as {
      inSec: number;
      outSec: number;
    };
    expect(committed.inSec).toBeGreaterThan(1);
    expect(committed.outSec).toBe(8);
  });

  it("scrubs the playhead from the track while the parent re-renders", () => {
    let latestSec = 0;
    const Wrapper = () => {
      const [sec, setSec] = useState(0);
      latestSec = sec;
      return (
        <PreviewScrubber
          currentSec={sec}
          durationSec={10}
          onSeek={setSec}
          trim={{
            inSec: 0,
            outSec: 10,
            onLiveChange: vi.fn(),
            onCommit: vi.fn(),
          }}
        />
      );
    };

    render(<Wrapper />);
    const track = mockTrackGeometry();

    fireEvent.pointerDown(track, {
      clientX: 100,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(window, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 150, pointerId: 1 });

    expect(latestSec).toBeCloseTo(7.5, 0);
  });
});
