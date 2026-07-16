/** Whether this WebView can run the WebCodecs decode worker path. */
export function webCodecsAvailable(): boolean {
  return typeof globalThis.VideoDecoder !== "undefined";
}

export type PreviewDecodeBackend = "webcodecs" | "htmlVideo";

export function previewDecodeBackend(): PreviewDecodeBackend {
  return webCodecsAvailable() ? "webcodecs" : "htmlVideo";
}
