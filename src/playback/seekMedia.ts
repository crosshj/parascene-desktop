/** Resolves true when a seek was issued, false when already at the target. */
export function seekMedia(el: HTMLMediaElement, sec: number): Promise<boolean> {
  let target = Math.max(0, sec);
  // Stay off the exact EOF so we don't land in `ended` (WebKit then refuses
  // to advance until a fresh seek after loop/wrap).
  if (Number.isFinite(el.duration) && el.duration > 0) {
    target = Math.min(target, Math.max(0, el.duration - 0.05));
  }
  if (
    !el.ended &&
    Number.isFinite(el.currentTime) &&
    Math.abs(el.currentTime - target) < 0.04
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", finish);
      window.clearTimeout(fallback);
      resolve(true);
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("seeked", finish);
    try {
      // Clear ended before assigning; some WebKit builds no-op seeks while ended.
      if (el.ended) el.pause();
      el.currentTime = target;
    } catch {
      finish();
    }
  });
}

export function waitForCurrentFrame(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("loadeddata", finish);
      el.removeEventListener("canplay", finish);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("loadeddata", finish);
    el.addEventListener("canplay", finish);
  });
}

/** Prefer rVFC so we know a frame at the seek target was actually produced. */
export function waitForPaintedFrame(el: HTMLVideoElement): Promise<void> {
  const withRvfc = el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  };
  if (typeof withRvfc.requestVideoFrameCallback === "function") {
    return new Promise((resolve) => {
      const fallback = window.setTimeout(resolve, 400);
      withRvfc.requestVideoFrameCallback!(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  }
  return waitForCurrentFrame(el);
}

export function waitForCanPlay(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("canplay", finish);
      window.clearTimeout(fallback);
      resolve();
    };
    const fallback = window.setTimeout(finish, 800);
    el.addEventListener("canplay", finish);
  });
}

/** One-shot seek for cut handoff — never chase a moving playhead. */
export async function alignToSourceSec(
  el: HTMLVideoElement,
  targetSec: number,
  cancelled: () => boolean,
): Promise<boolean> {
  const didSeek = await seekMedia(el, targetSec);
  if (cancelled()) return false;
  if (didSeek) {
    await waitForPaintedFrame(el);
    if (cancelled()) return false;
  }
  return true;
}
