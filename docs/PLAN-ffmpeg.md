# Plan — FFmpeg readiness

Before local preview, transcoding, thumbs, or render paths can be real, the desktop app must **verify FFmpeg is available and usable**, and **help the user** when it is not.

This is separate from shipping full timeline editing / render UI (still later). Detection + guided setup should land before those features depend on it.

## Goals

1. **Detect** an usable `ffmpeg` (and ideally `ffprobe`) on the machine — PATH, and/or a known install location, and/or a bundled binary later.
2. **Validate** it can run (version / short probe), not just that a file exists.
3. **Surface status** in the app (e.g. settings / About / first-use of a media action): ready vs missing vs broken.
4. **Assist install** when missing or broken — clear copy and a guided path for macOS developers/users (e.g. Homebrew `brew install ffmpeg`, link to docs, optional “Open Terminal with command”, re-check button). Do not silently fail media actions with an opaque error.

## Non-goals (for this readiness pass)

- Bundling a full notarized FFmpeg inside the app (possible later; keep as option)
- Implementing timeline editing, export pipelines, or Hook publish on top of FFmpeg yet
- Assuming FFmpeg is always present because CI or the developer machine has it

## Suggested shape

- Rust command(s): resolve binary, run `--version` / probe, return structured status
- TypeScript capability beside existing stubs in `src/capabilities/` (e.g. `FfmpegRuntime`)
- UI: blocking or soft gate only when a feature needs it; Library browse may not require FFmpeg until generate-thumbs / local preview

## Open decisions (when implementing)

- System PATH vs Homebrew default paths vs future app-bundled binary
- Minimum FFmpeg version / required codecs
- Whether first Library sync offers “prepare media tools” or wait until first media action
