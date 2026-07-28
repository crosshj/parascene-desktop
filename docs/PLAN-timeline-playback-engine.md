# Plan — Timeline playback engine (outside React)

**Status:** Proposed direction  
**Date:** July 2026  
**Related:** [PLAN-timeline-fill.md](./PLAN-timeline-fill.md), [PLAN-ffmpeg.md](./PLAN-ffmpeg.md), [PLAN-image-clip-preview.md](./PLAN-image-clip-preview.md)

**Motivation:** Program-monitor playback (`TimelineMonitor.tsx`) has grown into a real-time media sync engine implemented inside React. Recent cut-handoff and reverse-clip fixes work, but required ref gymnastics, effect splitting, and cache pre-warming patterns that fight the framework. The playback core belongs in plain TypeScript with direct DOM ownership; React should host and command it, not implement it.

---

## Principle

**UI framework for chrome; imperative engine for A/V sync.**

React is the right home for editor layout, transport chrome, clip thumbnails, generation overlays, and anything that changes on user action. Sub-frame video/audio synchronization — decoder pools, seek alignment, cut handoffs, look-ahead priming — is a **time-driven state machine** and should not re-render 60 times per second through a component tree.

---

## Current architecture (problems)

Today the program monitor lives entirely in React:

| Piece | Location | Issue |
| --- | --- | --- |
| Playhead clock (while playing) | `EditorLayout` RAF → `livePlayheadSec` state | Forces React updates every frame |
| Frame resolution | `resolveTimelineFrame()` in `timelineCompose.ts` | Re-run on every playhead tick via props |
| Decoder pool | `TimelineMonitor` maps clips → `PersistentVideo` / `PersistentImage` | N persistent elements as React children |
| Cut handoff | `activeKey` vs `visibleKey`, `onDecoderReady`, seek-then-show | Async state machine expressed as effects + refs |
| Standby priming | `peekNextVisualClip`, `parkSourceByKey`, standby seek effects | Competes with activation effects; easy to race |
| Reverse / bake sources | `useReversedDetail`, `ensureReversedMedia`, extend/slideshow decoders | Cache and IPC timing mixed into hook lifecycle |
| Play / pause / scrub | Multiple `useEffect` branches with overlapping deps | `clockSync` vs free-run split; lint rules about setState in effects |

**Symptoms users see:** stutter or freeze at clip boundaries, worse on reverse bakes and cold decoders, and incremental fixes that add more complexity rather than removing it.

**Root cause:** React re-renders the monitor on every playhead frame while effects try *not* to react to every frame. We are using declarative UI for an imperative, real-time problem.

---

## Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│  React (EditorLayout, PreviewPane, TimelinePane)            │
│  • Transport UI, ruler, clip blocks, overlays               │
│  • Passes: clips[], seek(), play(), pause(), volume         │
│  • Subscribes: onTimeUpdate (throttled), onError, onReady   │
└──────────────────────────┬──────────────────────────────────┘
                           │ thin adapter hook
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  timelinePlaybackEngine.ts  (plain TS, no React)            │
│  • Owns container HTMLElement + child <video>/<audio>/<img> │
│  • Owns RAF while playing (playhead not in React state)     │
│  • Decoder pool keyed by asset×direction / bake identity    │
│  • Cut state machine: prime → align → show → free-run       │
│  • Source resolvers: forward media://, reverse bake, slideshow│
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Existing libs (unchanged or lightly wrapped)               │
│  • timelineCompose.ts — clip → sourceSec, layer at time t   │
│  • previewUrl / reversedMedia / slideshowMedia              │
│  • catalogClient — ensureLocal, ensureReversed              │
└─────────────────────────────────────────────────────────────┘
```

### React surface (thin)

```tsx
// Conceptual — not final API
function TimelineMonitorHost(props: {
  clips: TimelineClip[];
  playheadSec: number;       // authoritative when paused / scrubbing
  playing: boolean;
  volume: number;
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  onTimeUpdate?: (sec: number) => void;  // throttled, e.g. 4–10 Hz while playing
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTimelinePlaybackEngine(containerRef, props);
  return <div ref={containerRef} className="editor-preview-surface" />;
}
```

While **playing**, the engine owns the clock. React receives throttled `onTimeUpdate` for the timeline ruler only. While **paused**, React's `playheadSec` prop is the source of truth (scrub, click-to-seek).

### Engine responsibilities

1. **Lifecycle** — `create(container)`, `destroy()`, attach/detach DOM without React reconciliation.
2. **Timeline model** — `setClips(clips)`; diff decoder set; retire unused elements.
3. **Transport** — `play()`, `pause()`, `seek(sec)`, `setVolume(0–100)`.
4. **Composition** — call `resolveTimelineFrame` / `clipSourceSec` (keep existing pure functions).
5. **Decoder pool** — one persistent element per `assetDecoderKey` (forward, reverse, slideshow bake, extend bake); same rules as today.
6. **Cut pipeline** — single state machine per decoder:
   - standby: park at next clip in-point (look-ahead)
   - activate: one-shot seek (no playhead chase), painted-frame wait if needed
   - show: flip visible decoder
   - free-run: native `play()` at 1×; `clockSync` only when speed ≠ 1 or slideshow
7. **Source loading** — proactive `ensureReversedMedia` / `ensureLocal` for timeline assets; no React hooks.
8. **Events** — `onDecoderReady`, `onStall`, `onError`, throttled `onTimeUpdate`.

### What stays in React

- Timeline pane (clips, drag, resize, waveforms, thumbnails)
- Transport bar and keyboard shortcuts (Space → engine.play/pause)
- Preview overlays (generate video panel, staging, lightbox)
- Project persistence (`timelinePlayheadSec` when paused)
- Bake status UI (spinner on clip blocks; engine only needs `bakePath` on clips)

### What moves out of React

- `PersistentVideo`, `PersistentImage`, `AssetDecoder`, seek helpers
- `visibleKey` / `activeKey` handoff
- `mediaSeekEpoch` workarounds (engine handles discontinuities internally)
- Per-frame prop drilling of `sourceSec` into video children
- Most of `TimelineMonitor.tsx` (~1,200 lines today)

**Keep as shared pure modules:** `timelineCompose.ts`, `stagedClip` framing helpers, `assetDecoderKey`, clip speed/extend math.

---

## Phased migration

### Phase 0 — Document and freeze behavior (done / ongoing)

- Capture known-good behaviors and edge cases (this doc).
- No user-visible change.
- Optional: add a short manual test checklist (back-to-back cuts, reverse bake, speed ≠ 1, slideshow, loop wrap, scrub-while-playing).

### Phase 1 — Extract engine skeleton

- New module: `src/layouts/editor/timelinePlaybackEngine.ts` (or `src/playback/` if we want it library-agnostic).
- Move pure helpers first: `seekMedia`, `waitForPaintedFrame`, `alignToSourceSec`, `assetDecoderKey`, decoder list / park maps.
- Engine creates container, owns empty decoder map; no React wiring yet.
- Unit tests for composition + cut target time (no DOM).

### Phase 2 — Port decoder pool (parity with today)

- Port forward video, image, reverse, slideshow bake, extend bake paths into engine.
- Imperative DOM: create/update `<video>`, apply framing classes/styles (reuse `framingClassName`, `useVideoStretchStyle` logic as plain functions where possible).
- Match current cut handoff semantics (seek-then-show, hold outgoing frame).
- **Do not delete** `TimelineMonitor.tsx` yet; run engine behind a dev flag or parallel mount in tests.

### Phase 3 — Thin React adapter

- Replace `TimelineMonitor` body with `TimelineMonitorHost` + `useTimelinePlaybackEngine`.
- Move playhead RAF from `EditorLayout` into engine when `playing && timelineMonitorActive`.
- React: `onTimeUpdate` at ~5 Hz updates `livePlayheadSec` for ruler only.
- Remove `mediaSeekEpoch` if engine handles seek discontinuities on `seek()` / loop.

### Phase 4 — Cleanup and hardening

- Delete old effect-heavy components.
- Centralize reverse/forward prewarm in engine `setClips()`.
- Add lightweight diagnostics (optional): decoder warm state, last cut latency, stall reason.
- Performance pass: confirm no React commit during free-run playback.

### Phase 5 — Future (optional, not required for extraction)

- Canvas/WebGL compositor for transitions and LUT preview (CRT looks) — single output surface.
- WebCodecs decode path for tighter sync (large undertaking; only if native `<video>` ceiling is hit).
- Shared engine for Publisher scratch preview (same clip model, different output).

---

## API sketch (draft)

```typescript
export type TimelinePlaybackEngineOptions = {
  stageW: number;
  stageH: number;
  matteW: number;
  matteH: number;
  onTimeUpdate?: (sec: number) => void;
  onPlayingChange?: (playing: boolean) => void;
};

export type TimelinePlaybackEngine = {
  setClips(clips: readonly TimelineClip[]): void;
  setVolume(volume: number): void;
  seek(sec: number): void;
  play(): void;
  pause(): void;
  getCurrentTime(): number;
  isPlaying(): boolean;
  destroy(): void;
};

export function createTimelinePlaybackEngine(
  container: HTMLElement,
  options: TimelinePlaybackEngineOptions,
): TimelinePlaybackEngine;
```

Bake runtime status (`BakeInfo` generating/failed) can remain a React concern: clips simply gain/lose `bakePath` on the model; engine reacts on next `setClips`.

---

## Testing strategy

| Layer | What to test |
| --- | --- |
| Pure | `timelineCompose`, park maps, cut target sec, speed/reverse source mapping |
| Engine (jsdom / happy-dom) | State machine transitions with mocked `HTMLMediaElement` |
| Manual | Back-to-back AI clips, reverse bake mid-timeline, loop at sequence end, scrub during play, 5+ unique assets |
| Regression | Compare frame time at cut boundary before/after (screen recording or logged `currentTime`) |

---

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Large one-shot rewrite breaks subtle WebKit behavior | Phased port; keep old monitor until parity checklist passes |
| Framing/stretch preview diverges | Extract `videoStretchStyle` to non-hook helper shared by engine |
| Tauri `media://` URLs and cache-bust rules | Engine calls same `previewUrl` / `reversedMedia` modules |
| Publisher render preview diverges from editor | Long-term: one engine; short-term: editor-only extraction is fine |
| Team unfamiliar with imperative code | Engine is one file/module with clear public API; React stays familiar |

---

## Success criteria

1. **Playback** — Back-to-back cuts between forward clips, reverse bakes, and mixed assets feel continuous (no visible freeze > ~1 frame at cut when primed).
2. **React** — Zero re-renders of the monitor subtree during free-run playback; playhead ruler updates at throttled rate only.
3. **Code** — `TimelineMonitor.tsx` shrinks to a small host; engine is testable without React Testing Library.
4. **Maintainability** — New clip kinds (e.g. another bake type) add a decoder strategy in one place, not N new effects.

---

## Non-goals (for this plan)

- Rewriting the timeline **editor** (drag, merge, fill placeholders) in non-React code
- Replacing FFmpeg render pipeline or Publisher export
- Moving catalog/sync to the engine
- Real-time WebGL compositing in the first extraction pass

---

## Summary

| Question | Answer |
| --- | --- |
| Is React wrong for Parascene Desktop? | No — wrong for the **playback core** only |
| Plain JS module inside React? | Yes — imperative engine + container ref is the right split |
| Direct DOM manipulation? | Yes, for `<video>`/`<audio>`/hold-frame `<img>` under the engine |
| Rewrite everything now? | No — extract engine in phases; keep `timelineCompose` and URL helpers |
| When to start? | After current monitor fixes stabilize; Phase 1 is low-risk scaffolding |
