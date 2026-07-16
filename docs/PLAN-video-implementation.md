Replace the current preview implementation with a frame-accurate preview pipeline for this Tauri + React video editor.

Architecture:

React timeline
→ frame request scheduler
→ Web Worker
→ Mediabunny demuxing
→ WebCodecs VideoDecoder
→ decoded frame cache
→ persistent canvas preview

Keep FFmpeg, ffprobe, filesystem access, proxy generation, final rendering, and cache management in the Tauri/Rust layer. Keep interactive frame decoding inside the WebView. Do not send decoded RGBA frames through Tauri IPC.

Implement the following:

1. Make a persistent canvas the only visible preview surface.

2. Do not display `<video>` elements. Do not use a visible `<video>` element for seeking or playback.

3. Create a dedicated Web Worker for demuxing and decoding.

4. Use Mediabunny to:

   * Open local proxy video files.
   * Read track and codec metadata.
   * Build or access the encoded sample index.
   * Identify keyframes.
   * Retrieve encoded samples for decoding.

5. Use WebCodecs `VideoDecoder` to decode frames.

6. Create this abstraction:

```ts
interface FrameProvider {
	getFrame(
		assetId: string,
		sourceTimeUs: number,
		generation: number,
	): Promise<VideoFrame | null>;

	preload(
		assetId: string,
		startTimeUs: number,
		endTimeUs: number,
	): void;

	release(assetId: string): void;
}
```

7. Resolve timeline time before requesting a frame:

```ts
type FrameTarget = {
	assetId: string;
	sourceTimeUs: number;
	clipId: string;
};
```

The frame provider must not know about timeline clip placement. It only receives an asset and source timestamp.

8. For every requested source timestamp:

   * Find the closest keyframe at or before the target.
   * Begin decoding from that keyframe.
   * Decode forward until the frame covering the requested timestamp is available.
   * Return the closest correct frame.
   * Never return the first decoded frame merely because the requested frame is not ready.

9. Add monotonically increasing request generations.

```ts
let renderGeneration = 0;

async function renderAt(timelineTimeUs: number) {
	const generation = ++renderGeneration;
	const target = timeline.resolveFrameTarget(timelineTimeUs);

	if (!target) {
		return;
	}

	const frame = await frameProvider.getFrame(
		target.assetId,
		target.sourceTimeUs,
		generation,
	);

	if (!frame) {
		return;
	}

	if (generation !== renderGeneration) {
		frame.close();
		return;
	}

	renderFrame(frame);
	frame.close();
}
```

10. Reject all stale decoder output. A frame from an older scrub request must never replace a newer frame.

11. Keep the last valid canvas frame visible while a new frame is being decoded. Do not clear the canvas when seeking begins.

12. Add a decoded-frame cache keyed by asset ID and frame timestamp.

13. Cache a small range around the current playhead.

14. When the playhead approaches a clip seam, preload both sides:

* Cache frames near the outgoing clip’s source out-point.
* Cache frames near the incoming clip’s source in-point.
* Keep both assets warm while scrubbing near the cut.

15. Do not create, configure, reset, or destroy a decoder for every pointer movement.

16. Reuse decoders where possible.

17. Reset a decoder only when required by a discontinuous seek or asset change.

18. Close every `VideoFrame` that is:

* Rendered.
* Evicted from the cache.
* Rejected as stale.
* Superseded.
* Returned after cancellation.

19. Bound the cache by memory usage or frame count. Do not allow unbounded native `VideoFrame` retention.

20. Use Canvas 2D initially:

```ts
function renderFrame(frame: VideoFrame) {
	const canvas = previewCanvasRef.current;
	const ctx = canvas?.getContext("2d");

	if (!canvas || !ctx) {
		return;
	}

	ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
}
```

Do not introduce WebGPU yet. Keep the compositor behind an interface so Canvas 2D can later be replaced with WebGL or WebGPU.

21. Generate normalized preview proxies through Tauri and FFmpeg during import.

Use this initial proxy format:

```text
H.264
1280×720 maximum
constant 30 fps
yuv420p
keyframe every 10 frames
AAC audio
```

Keep the original file for final export.

22. Use `VideoDecoder.isConfigSupported()` before opening a proxy.

23. Fail clearly if the current WebView cannot decode the configured proxy format.

24. Serve local proxy files through Tauri’s local asset protocol or another scoped local-file mechanism. Do not load entire video files into JavaScript through Tauri commands.

25. Keep audio out of the first implementation. Do not block frame-accurate scrubbing on audio playback or synchronization.

26. Preserve the current timeline and clip model. Replace only the preview frame acquisition and rendering path.

27. Add instrumentation for:

* Requested timeline time.
* Resolved asset ID.
* Requested source timestamp.
* Returned frame timestamp.
* Keyframe used.
* Decode duration.
* Cache hit or miss.
* Request generation.
* Stale frame rejection.
* Number of live cached frames.

28. Add automated or repeatable tests for these cases:

* Scrub forward across a seam.
* Scrub backward across a seam.
* Move repeatedly between the final frames of one clip and the first frames of the next.
* Jump between distant positions rapidly.
* Issue a new scrub request before the previous request finishes.
* Alternate rapidly between two assets.
* Use video containing B-frames.
* Scrub continuously for several minutes and verify stable memory usage.
* Verify that the first frame of the incoming clip never flashes unless it is the requested frame.
* Verify that a stale frame is never rendered.

The first completed milestone is:

Two local proxy videos on one timeline, one seam between them, and smooth forward and backward scrubbing across that seam with no incorrect-frame flash, no stale frame rendering, and stable memory usage.

Do not add transitions, audio synchronization, multi-track compositing, effects, WebGPU, or final export work until this milestone works correctly.
