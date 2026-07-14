# Parascene Desktop

macOS shell for Parascene (Tauri 2 + React + TypeScript). This pass scaffolds the product shell — not video editing.

## Prerequisites

- macOS
- Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20+
- Rust via **rustup** (stable): https://rustup.rs — Homebrew’s older `rust` formula is often too old for Tauri 2

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
| `npm run desktop:dev` | Run the macOS app (Tauri + Vite) |
| `npm run desktop:build` | Production macOS bundle |
| `npm run desktop:test` | Vitest |
| `npm run lint` / `npm run typecheck` | Quality gates |

## Authentication

Matches [Log in with Parascene](https://www.parascene.com/help/developer/login-with-parascene) for **public / native** clients:

1. Click **Log in with Parascene**
2. System browser opens **Parascene** `/oauth/authorize` (consent / trust this app)
3. After approve, browser returns to the app via loopback `http://127.0.0.1:17423/oauth/callback`
4. App exchanges the auth code with Parascene `/oauth/token` using PKCE only (no developer API key)
5. Access/refresh tokens + userinfo are stored in the **macOS Keychain**
6. Further Parascene API calls go through `src/sdk/parascene.ts`

## Download & install (Release DMG)

1. Open the repo **Releases** page and download the DMG from **Desktop — latest main** (or a `desktop-v*` release).
2. Open the DMG and drag **Parascene** into **Applications**.
3. Clear Gatekeeper quarantine (unsigned builds look “damaged” otherwise):

```bash
xattr -cr /Applications/Parascene.app
```

4. Open Parascene from Applications (or Spotlight).

Alternative to step 3: Right-click the app → **Open** → **Open**.

## Releases / CI

GitHub Actions workflow: `.github/workflows/macos-desktop.yml`

- Pushes to `main` update prerelease **Desktop — latest main** (`desktop-latest`) with the DMG.
- Push a `desktop-v*` tag for a versioned release.
- PRs also upload workflow **Artifacts**; prefer the Releases DMG for sharing.
- Builds are unsigned Apple Silicon (`macos-14`). Codesign + notarization come later.

## Layouts

- **Director** (default) — preview, scenes, instruction box
- **Editor** — assets, preview, timeline stub, assistant stub
- **Hook** — vertical preview, 9s range stub, suggestions, disabled publish

Fixtures live under `src/fixtures/` and back a `ProjectRepository` interface.

## Non-goals (this pass)

No timeline editing, FFmpeg, rendering, generation, or real Hook publishing.

## Plans / roadmap

- [docs/PLAN-from-chatgpt.md](docs/PLAN-from-chatgpt.md) — where the product plan stands (shell done → Library next)
- [docs/PLAN-architecture-principles.md](docs/PLAN-architecture-principles.md) — local-first; ease web/DB load; gens without Creation rows (maybe)
- [docs/PLAN-library-sync.md](docs/PLAN-library-sync.md) — local Library + sync design
- [docs/PLAN-macos-desktop-shell.md](docs/PLAN-macos-desktop-shell.md) — shell leftovers (About / updates)
- [docs/PLAN-ffmpeg.md](docs/PLAN-ffmpeg.md) — FFmpeg detect + install assist
- [docs/PLAN-parascene-generation.md](docs/PLAN-parascene-generation.md) — generation API deps (first–last frame, short duration, prompt relay)
- [docs/mockups/](docs/mockups/) — Director / Editor / Hook / Library target visuals
