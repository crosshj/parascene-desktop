# OS code signing (optional follow-up)

Tauri **updater** signing (minisign keypair / `TAURI_SIGNING_PRIVATE_KEY`) is separate from **OS** code signing. OS signing removes Gatekeeper / SmartScreen friction on **first install** and hardens the macOS update path. Neither requires the Mac App Store nor the Microsoft Store.

## macOS — Developer ID + notarization

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) ($99/yr).
2. Create a **Developer ID Application** certificate in Xcode / developer.apple.com.
3. Export a `.p12` and add GitHub Actions secrets (names match Tauri’s conventions):

| Secret | Purpose |
|--------|---------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: …` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | [App-specific password](https://support.apple.com/en-us/HT204397) |
| `APPLE_TEAM_ID` | 10-character team id |

4. Wire those env vars into the macOS build step in [`.github/workflows/macos-desktop.yml`](../.github/workflows/macos-desktop.yml). `tauri build` will codesign and notarize when they are present.
5. After notarized builds ship, README Gatekeeper `xattr` workarounds can be dropped for new installs.

## Windows — Authenticode

1. Purchase an **OV** or **EV** code signing certificate from a public CA (not an SSL cert).
2. Export `.pfx` and add secrets, e.g.:

| Secret | Purpose |
|--------|---------|
| `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` password |

3. Pass them into the Windows build step (Tauri / `signtool` via env — see [Tauri Windows code signing](https://v2.tauri.app/distribute/sign-windows/)).
4. SmartScreen reputation still builds over time for OV certs; EV is smoother on first download.

## Relationship to in-app updates

- **Updater pubkey** in `tauri.conf.json` + `TAURI_SIGNING_PRIVATE_KEY` — required for Help → Check for Updates.
- **OS codesign** — optional polish for first-install trust; recommended before wide distribution.
