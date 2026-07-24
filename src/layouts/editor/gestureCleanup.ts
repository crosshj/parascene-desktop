import { clearStagedClipDrag } from "./stagedClip";

const BODY_DRAG_CLASSES = [
  "is-preview-trim-dragging",
  "is-timeline-clip-moving",
  "is-timeline-clip-resizing",
  "is-staged-clip-dragging",
] as const;

type GestureAbortListener = () => void;
const gestureAbortListeners = new Set<GestureAbortListener>();

export function releasePointerCaptureSafe(
  target: Element | null | undefined,
  pointerId: number | null | undefined,
): void {
  if (!target || pointerId == null) return;
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Element may be detached or capture already released.
  }
}

export function clearEditorBodyDragClasses(): void {
  for (const className of BODY_DRAG_CLASSES) {
    document.body.classList.remove(className);
  }
}

export function subscribeGestureAbort(listener: GestureAbortListener): () => void {
  gestureAbortListeners.add(listener);
  return () => {
    gestureAbortListeners.delete(listener);
  };
}

/** Abort in-flight drags after focus loss or a lost pointer. */
export function abortEditorGestures(): void {
  clearEditorBodyDragClasses();
  clearStagedClipDrag();
  for (const listener of gestureAbortListeners) {
    listener();
  }
}

export function installEditorGestureSafetyNet(): () => void {
  const onBlur = () => {
    abortEditorGestures();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      abortEditorGestures();
    }
  };
  const onPointerCancel = () => {
    if (
      !BODY_DRAG_CLASSES.some((className) =>
        document.body.classList.contains(className),
      )
    ) {
      return;
    }
    abortEditorGestures();
  };

  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pointercancel", onPointerCancel, { capture: true });

  return () => {
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pointercancel", onPointerCancel, {
      capture: true,
    });
  };
}
