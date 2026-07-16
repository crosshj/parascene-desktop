/** Canvas 2D compositor — swappable later for WebGL / WebGPU. */

export type PreviewCompositor = {
  drawVideoFrame(frame: VideoFrame): void;
  drawVideoElement(el: HTMLVideoElement): void;
  drawImageBitmap(bitmap: ImageBitmap): void;
  clear(): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
};

/** Letterbox source into dest (object-fit: contain). */
export function containRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): { dx: number; dy: number; dw: number; dh: number } {
  if (srcW <= 0 || srcH <= 0 || destW <= 0 || destH <= 0) {
    return { dx: 0, dy: 0, dw: destW, dh: destH };
  }
  const scale = Math.min(destW / srcW, destH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return {
    dx: (destW - dw) / 2,
    dy: (destH - dh) / 2,
    dw,
    dh,
  };
}

export function createCanvas2DCompositor(
  canvas: HTMLCanvasElement,
): PreviewCompositor {
  const maybeCtx = canvas.getContext("2d", { alpha: false });
  if (!maybeCtx) {
    throw new Error("Could not get 2D canvas context for preview");
  }
  const ctx = maybeCtx;

  function fillLetterbox(): void {
    ctx.fillStyle = "#050507";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawContain(
    source: CanvasImageSource,
    srcW: number,
    srcH: number,
  ): void {
    fillLetterbox();
    const { dx, dy, dw, dh } = containRect(
      srcW,
      srcH,
      canvas.width,
      canvas.height,
    );
    ctx.drawImage(source, dx, dy, dw, dh);
  }

  return {
    resize(cssWidth, cssHeight, dpr) {
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      canvas.style.width = `${Math.max(1, Math.round(cssWidth))}px`;
      canvas.style.height = `${Math.max(1, Math.round(cssHeight))}px`;
    },

    drawVideoFrame(frame) {
      drawContain(frame, frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
    },

    drawVideoElement(el) {
      const w = el.videoWidth || el.clientWidth || 1;
      const h = el.videoHeight || el.clientHeight || 1;
      drawContain(el, w, h);
    },

    drawImageBitmap(bitmap) {
      drawContain(bitmap, bitmap.width, bitmap.height);
    },

    clear() {
      fillLetterbox();
    },
  };
}

export function renderFrame(canvas: HTMLCanvasElement, frame: VideoFrame): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { dx, dy, dw, dh } = containRect(
    frame.displayWidth || frame.codedWidth,
    frame.displayHeight || frame.codedHeight,
    canvas.width,
    canvas.height,
  );
  ctx.fillStyle = "#050507";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(frame, dx, dy, dw, dh);
}
