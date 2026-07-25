import { describe, expect, it, vi } from "vitest";
import {
  abortEditorGestures,
  clearEditorBodyDragClasses,
  installEditorGestureSafetyNet,
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

  it("does not abort staged-clip drag on pointercancel", () => {
    const uninstall = installEditorGestureSafetyNet();
    const listener = vi.fn();
    const unsubscribe = subscribeGestureAbort(listener);
    document.body.classList.add("is-staged-clip-dragging");

    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));

    expect(listener).not.toHaveBeenCalled();
    expect(document.body.classList.contains("is-staged-clip-dragging")).toBe(
      true,
    );

    document.body.classList.remove("is-staged-clip-dragging");
    unsubscribe();
    uninstall();
  });

  it("aborts other editor drags on pointercancel", () => {
    const uninstall = installEditorGestureSafetyNet();
    const listener = vi.fn();
    const unsubscribe = subscribeGestureAbort(listener);
    document.body.classList.add("is-timeline-clip-moving");

    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("is-timeline-clip-moving")).toBe(
      false,
    );

    unsubscribe();
    uninstall();
  });
});
