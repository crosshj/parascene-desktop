import {
  useEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  videoStretchStyle,
  type StagedClipFraming,
} from "./stagedClip";

/**
 * Inline style that forces Stretch framing on `<video>` when CSS
 * `object-fit: fill` is ignored by the engine.
 *
 * `remountKey` should change when the video element is recreated (e.g. src).
 */
export function useVideoStretchStyle(
  framing: StagedClipFraming,
  videoRef: RefObject<HTMLVideoElement | null>,
  remountKey?: string | null,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>();

  useEffect(() => {
    if (framing !== "stretch") return;

    const el = videoRef.current;
    if (!el) return;
    let cancelled = false;

    const update = () => {
      if (cancelled) return;
      const next = videoStretchStyle(
        el.videoWidth,
        el.videoHeight,
        el.clientWidth,
        el.clientHeight,
      );
      setStyle(next ?? undefined);
    };

    queueMicrotask(update);
    el.addEventListener("loadedmetadata", update);
    el.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      cancelled = true;
      el.removeEventListener("loadedmetadata", update);
      el.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [framing, videoRef, remountKey]);

  return framing === "stretch" ? style : undefined;
}
