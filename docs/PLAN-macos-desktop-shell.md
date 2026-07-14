# Desktop shell — remaining

- **Updates (near-term):** In an **About this app** modal — check for a newer GitHub Release and, if so, show “New version available” with a link to the release page. Manual DMG install until signed auto-update exists.
- **Auto-updates (later):** GitHub Releases + Tauri updater plugin (download/apply in-app). Needs Apple codesign + notarization. Ship DMGs via `desktop-v*` tags in the meantime.
