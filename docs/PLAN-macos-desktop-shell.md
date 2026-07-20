# Desktop shell — remaining / polish

Shell acceptance from the ChatGPT scaffold prompt is largely **met** (Tauri app, layouts, auth, fixtures, CI/DMG). See [PLAN-from-chatgpt.md](./PLAN-from-chatgpt.md).

Next product work is **Library + sync**, not more shell chrome: [PLAN-library-sync.md](./PLAN-library-sync.md).

## Still remaining (shell)

- ~~**Launch white flash:**~~ Fixed — window starts `visible: false`, shows after first page load, and macOS WKWebView uses dark `backgroundColor` via `macOSPrivateApi` / wry `drawsBackground`.
- **FFmpeg readiness (before media pipelines):** Detect whether FFmpeg is installed and usable; if not, assist the user (install guidance + re-check). See [PLAN-ffmpeg.md](./PLAN-ffmpeg.md). Not full editing/render yet — but do not assume FFmpeg is present.
- **Updates (near-term):** In an **About this app** modal — check for a newer GitHub Release and, if so, show “New version available” with a link to the release page. Manual DMG install until signed auto-update exists.
- **Auto-updates (later):** GitHub Releases + Tauri updater plugin (download/apply in-app). Needs Apple codesign + notarization. Ship DMGs via `desktop-v*` tags in the meantime.
