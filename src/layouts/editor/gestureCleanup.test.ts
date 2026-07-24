import { describe, expect, it, vi } from "vitest";
import {
  abortEditorGestures,
  clearEditorBodyDragClasses,
  releasePointerCaptureSafe,
  subscribeGestureAbort,
} from "./gestureCleanup";

describe("gestureCleanup", () => {
  it("clears editor drag body classes", () => {
    document.body.classList.add(
      "is-preview-trim-dragging",
      "is-timeline-clip-moving",
      "is-staged-clip-dragging",
    );
    clearEditorBodyDragClasses();
    expect(document.body.classList.contains("is-preview-trim-dragging")).toBe(
      false,
    );
    expect(document.body.classList.contains("is-timeline-clip-moving")).toBe(
      false,
    );
    expect(document.body.classList.contains("is-staged-clip-dragging")).toBe(
      false,
    );
  });

  it("notifies gesture abort subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGestureAbort(listener);
    abortEditorGestures();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    abortEditorGestures();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("releases pointer capture when held", () => {
    const target = document.createElement("div");
    const release = vi.fn();
    target.hasPointerCapture = vi.fn(() => true);
    target.releasePointerCapture = release;
    releasePointerCaptureSafe(target, 7);
    expect(release).toHaveBeenCalledWith(7);
  });
});
