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

## CI artifacts

GitHub Actions workflow: `.github/workflows/macos-desktop.yml`

- Triggers: `workflow_dispatch`, `desktop-v*` tags, and path-filtered pushes/PRs
- Produces unsigned **DMG** / `.app` artifacts (Apple Silicon runner `macos-14`)
- Tag builds attach assets to a GitHub Release

### Unsigned installs / Gatekeeper

Unsigned builds may be blocked by Gatekeeper. Typical unblock:

- Right-click the app → **Open**, or
- `xattr -cr /path/to/Parascene.app`

### Future signing (not required for this pass)

- Apple Developer Team ID
- `APPLE_CERTIFICATE` / certificate password
- `APPLE_ID` / app-specific password or API key for notarization
- Entitlements as required by Tauri bundler docs

## Layouts

- **Director** (default) — preview, scenes, instruction box
- **Editor** — assets, preview, timeline stub, assistant stub
- **Hook** — vertical preview, 9s range stub, suggestions, disabled publish

Fixtures live under `src/fixtures/` and back a `ProjectRepository` interface.

## Non-goals (this pass)

No timeline editing, FFmpeg, rendering, generation, or real Hook publishing.
