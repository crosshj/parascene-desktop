/** True when the element is already sitting on `sec` (paused or playing). */
export function mediaAtSec(
  el: HTMLMediaElement,
  sec: number,
  slop = 0.04,
): boolean {
  const target = Math.max(0, sec);
  return (
    !el.ended &&
    Number.isFinite(el.currentTime) &&
    Math.abs(el.currentTime - target) < slop
  );
}

function hasMediaSrc(el: HTMLMediaElement): boolean {
  return Boolean(el.currentSrc || el.src || el.getAttribute("src"));
}

/** Seek is a no-op until duration/currentTime exist. */
export function waitForMetadata(el: HTMLMediaElement): Promise<void> {
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  if (!hasMediaSrc(el)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("loadedmetadata", finish);
      globalThis.clearTimeout(fallback);
      resolve();
    };
    const fallback = globalThis.setTimeout(finish, 800);
    el.addEventListener("loadedmetadata", finish);
  });
}

/** Resolves true when a seek was issued, false when already at the target. */
export async function seekMedia(
  el: HTMLMediaElement,
  sec: number,
): Promise<boolean> {
  await waitForMetadata(el);
  let target = Math.max(0, sec);
  // Stay off the exact EOF so we don't land in `ended` (WebKit then refuses
  // to advance until a fresh seek after loop/wrap).
  if (Number.isFinite(el.duration) && el.duration > 0) {
    target = Math.min(target, Math.max(0, el.duration - 0.05));
  }
  if (mediaAtSec(el, target)) {
    return false;
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", finish);
      globalThis.clearTimeout(fallback);
      resolve(true);
    };
    const fallback = globalThis.setTimeout(finish, 800);
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
      globalThis.clearTimeout(fallback);
      resolve();
    };
    const fallback = globalThis.setTimeout(finish, 800);
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
      const fallback = globalThis.setTimeout(resolve, 400);
      withRvfc.requestVideoFrameCallback!(() => {
        globalThis.clearTimeout(fallback);
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
      globalThis.clearTimeout(fallback);
      resolve();
    };
    const fallback = globalThis.setTimeout(finish, 800);
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
