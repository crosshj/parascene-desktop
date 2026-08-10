# Parascene Desktop

Desktop shell for Parascene (Tauri 2 + React + TypeScript) on **macOS** and **Windows**.

## Prerequisites

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the “Desktop development with C++” workload (for local builds). The NSIS installer installs WebView2 automatically if missing.
- Node.js 20+
- Rust via **rustup** (stable): https://rustup.rs — put `~/.cargo/bin` (or `%USERPROFILE%\.cargo\bin`) ahead of Homebrew’s older `rust` formula when both are installed
- **Local media tools** (FFmpeg, Demucs for Lab vocals/a2v): see [LOCAL_TOOLS.md](LOCAL_TOOLS.md) — also **Settings → Local tools** in the app

## Install

```bash
npm ci
# or: npm install
```

Public **app id** (`client_id`) is baked into `src/sdk/config.ts`. On Parascene **Connections**, register the app as a **Native / public** client with redirect URL:

```text
http://127.0.0.1:17423/oauth/callback
```

## Commands

| Script | Purpose |
|--------|---------|
| `npm run dev` | Run the desktop app (needs Rust — see Prerequisites) |
| `npm run build` | Production bundle (DMG on macOS, NSIS `.exe` on Windows) |
| `npm run test` | Vitest |
| `npm run lint` / `npm run typecheck` | Quality gates |

`vite:dev` / `vite:build` are internals used by Tauri — don’t run them alone.

## Authentication

Matches [Log in with Parascene](https://www.parascene.com/help/developer/login-with-parascene) for **public / native** clients:

1. Click **Log in with Parascene**
2. System browser opens **Parascene** `/oauth/authorize` (consent / trust this app)
3. After approve, browser returns to the app via loopback `http://127.0.0.1:17423/oauth/callback`
4. App exchanges the auth code with Parascene `/oauth/token` using PKCE only (no developer API key)
5. Access/refresh tokens + userinfo are stored in the OS secure store in **release** builds (macOS Keychain / Windows Credential Manager). In **debug** (`tauri dev`), they live in the local catalog SQLite (`…/Parascene/Library/catalog.sqlite`) so the secure store does not prompt on every restart.
6. Further Parascene API calls go through `src/sdk/parascene.ts`

## Download & install

Open the repo **Releases** page → **Desktop — latest main**.

| Platform | Download this file |
| --- | --- |
| macOS (Apple Silicon) | `Parascene Desktop_<version>_aarch64.dmg` |
| Windows (x64) | `Parascene Desktop_<version>_x64-setup.exe` |

Skip `.sig`, `.app.tar.gz`, and `latest.json` (those are for in-app updates).

### macOS (Apple Silicon DMG)

1. Open the DMG and drag **Parascene Desktop** into **Applications**.
2. Clear Gatekeeper quarantine (unsigned builds look “damaged” otherwise):

```bash
xattr -cr "/Applications/Parascene Desktop.app"
```

3. Open Parascene Desktop from Applications (or Spotlight).

Alternative to step 2: Right-click the app → **Open** → **Open**.

### Windows (x64 NSIS)

1. Run the **`…_x64-setup.exe`** installer.
2. If SmartScreen warns (unsigned builds), choose **More info** → **Run anyway**.
3. WebView2 is installed automatically when missing.

## Releases / CI

GitHub Actions:

- `.github/workflows/macos-desktop.yml` — Apple Silicon DMG
- `.github/workflows/windows-desktop.yml` — Windows x64 NSIS

- Pushes to `main` update prerelease **Desktop — latest main** (`desktop-latest`) with both platform installers.
- Push a `desktop-v*` tag for a versioned release (both workflows attach artifacts + updater `latest.json`).
- PRs also upload workflow **Artifacts**; prefer the Releases page for sharing.
- **Updater signing** (Tauri keypair) is required for CI builds — see [docs/PLAN-desktop-updater.md](docs/PLAN-desktop-updater.md). Set `TAURI_SIGNING_PRIVATE_KEY` in repo secrets.
- **OS codesign** (Apple Developer ID / Windows Authenticode) is still optional — [docs/PLAN-os-codesign.md](docs/PLAN-os-codesign.md). Until then, use the install workarounds below for first install; later versions can update in-app via **Help → Check for Updates…**.

## Chrome & layouts

Header: **Library** | **Project** · spacer · context tabs. Library context: Creations | Sync. Project context (when open): Director | Editor | Hook.

- **Library** — Creations + Sync read local SQLite; **Sync from Parascene** pulls your creations list (`GET /api/create/images`). Media file download comes later.
- **Project** — picker when nothing is open; workspace modes when loaded
- **Director** — preview, scenes, instruction box
- **Editor** — assets, preview, timeline stub, assistant stub
- **Hook** — vertical preview, 9s range stub, suggestions, disabled publish

Fixtures under `src/fixtures/` still back the Project workspace mock. The Library catalog is filled by syncing from your Parascene account.

## Local data root

On first Library open the app creates (under the OS videos folder — `~/Movies` on macOS, `Videos` on Windows):

```text
…/Parascene/
  Library/          # durable media + catalog.sqlite
  Projects/
  Exports/
  Cache/
```

Catalog metadata is SQLite under `Library/`. **Sync from cloud** pulls the full creations list, then downloads the newest screenful of media; more pages download as you scroll the Creations grid. Files land in `Library/media` and `Library/thumbs`.

API origin defaults to `https://api.parascene.com` (override with `VITE_PARASCENE_API_BASE_URL`).

## Non-goals (this pass)

No timeline editing, FFmpeg, rendering, generation, or real Hook publishing.

## Plans / roadmap

- [docs/PLAN-from-chatgpt.md](docs/PLAN-from-chatgpt.md) — where the product plan stands (shell done → Library next)
- [docs/GUIDE-architecture-principles.md](docs/GUIDE-architecture-principles.md) — local-first; ease web/DB load; gens without Creation rows (maybe)
- [docs/PLAN-library-sync.md](docs/PLAN-library-sync.md) — local Library + sync design
- [docs/PLAN-macos-desktop-shell.md](docs/PLAN-macos-desktop-shell.md) — shell leftovers
- [docs/PLAN-desktop-updater.md](docs/PLAN-desktop-updater.md) — in-app updates (Tauri updater)
- [docs/PLAN-os-codesign.md](docs/PLAN-os-codesign.md) — Apple / Windows OS signing (optional)
- [docs/PLAN-ffmpeg.md](docs/PLAN-ffmpeg.md) — FFmpeg detect + install assist
- [LOCAL_TOOLS.md](LOCAL_TOOLS.md) — FFmpeg, Demucs, and other local installs for Lab/Editor
- [docs/PLAN-parascene-generation.md](docs/PLAN-parascene-generation.md) — generation API deps (first–last frame, short duration, prompt relay)
- [docs/mockups/](docs/mockups/) — Director / Editor / Hook / Library target visuals
