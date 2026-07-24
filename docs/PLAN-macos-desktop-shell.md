# Desktop shell — remaining / polish

Shell acceptance from the ChatGPT scaffold prompt is largely **met** (Tauri app, layouts, auth, fixtures, CI/DMG). See [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md).

Next product work is **Library + sync**, not more shell chrome: [PLAN-library-sync.md](./PLAN-library-sync.md).

## Still remaining (shell)

- ~~**Launch white flash:**~~ Fixed — window starts `visible: false`, shows after first page load, and macOS WKWebView uses dark `backgroundColor` via `macOSPrivateApi` / wry `drawsBackground`.
- **FFmpeg readiness (before media pipelines):** Detect whether FFmpeg is installed and usable; if not, assist the user (install guidance + re-check). See [PLAN-ffmpeg.md](./PLAN-ffmpeg.md). Not full editing/render yet — but do not assume FFmpeg is present.
- **Updates:** In-app via Tauri updater — **Help → Check for Updates…**. See [PLAN-desktop-updater.md](./PLAN-desktop-updater.md). First install may still need Gatekeeper / SmartScreen workarounds until OS codesign — [PLAN-os-codesign.md](./PLAN-os-codesign.md).
- ~~**Auto-updates (later):**~~ Implemented (updater plugin + CI `latest.json`). OS codesign remains optional polish.
