# Plan from ChatGPT — Desktop App for Parascene

Source: [ChatGPT share](https://chatgpt.com/share/6a56996c-fb70-83ea-a3c0-1bb8b4468f30)

## Where we are

The conversation has two beats:

1. **Scaffold prompt (~12:14)** — Build a macOS-first Tauri 2 + React product shell: Director / Editor / Hook, Parascene login, CI/DMG, fixtures; no real video editing.
2. **Library design (~3:33)** — After “bones in place,” the question was where local user assets should live. Answer: **Library is a first-class level above editing modes**; synchronization is native background infrastructure, not React UI logic.

**Repo status:** Phase 1 (shell) is largely **done** on `main`. Phase 2 (**Library + sync**) is **designed in chat, not implemented**. Shell polish leftovers (About / updates) are tracked separately.

```text
Shell scaffold (done)
  → Library + sync (next)
  → Platform generation deps (first–last frame, short duration, prompt relay)
  → FFmpeg readiness + shell polish / signing
```

Related plans:

- [PLAN-architecture-principles.md](./PLAN-architecture-principles.md) — local-first; ease web/DB load; optional gens without Parascene Creation rows (undecided)
- [PLAN-library-sync.md](./PLAN-library-sync.md) — next product phase
- [PLAN-parascene-generation.md](./PLAN-parascene-generation.md) — API/product deps for AI video creation
- [PLAN-macos-desktop-shell.md](./PLAN-macos-desktop-shell.md) — shell remaining / polish
- [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) — detect FFmpeg + help user install if missing
- [mockups/](./mockups/) — Director / Editor / Hook mocks + Library wireframe

### Mockups are references, not specs

Mockups and ChatGPT wireframes are **directional**. Customize them: where a mock conflicts with patterns already in the app (shell chrome, tokens, typography, auth strip, mode switcher), **prefer the existing app pattern** and adapt the useful layout ideas. Do not treat the PNGs as a pixel-perfect redesign. Details: [mockups/README.md](./mockups/README.md).

### Auth note

The ChatGPT prompt suggested a custom URL scheme (`parascene://auth/callback`). This app shipped **loopback OAuth** instead:

```text
http://127.0.0.1:17423/oauth/callback
```

Keep documenting what shipped; do not reinvent auth.

## Shell scaffold — checklist

| Requirement | Status |
| --- | --- |
| Tauri 2 + React + TypeScript; `desktop:dev` / `build` / `test` | Done |
| GitHub Actions macOS DMG (`desktop-latest`, `desktop-v*`) | Done (unsigned) |
| Director / Editor / Hook navigable layouts | Done (placeholders) |
| Parascene login (PKCE, Keychain, logout, status) | Done |
| Mock project data / fixtures isolated | Done |
| Module boundaries + capability stubs | Done |
| README: local dev, CI, Gatekeeper | Done |
| Codesign / notarization | Deferred |
| In-app About / update check | Deferred — see shell plan |
| Kill white flash on launch (before maximize) | Open — see shell plan |
| Library + local asset sync | Next — see library plan |
| FFmpeg detect + user install assist | Planned — see [PLAN-ffmpeg.md](./PLAN-ffmpeg.md) |
| Parascene generation: first–last frame, duration &lt;~9s, prompt relay | Platform-dependent — see [PLAN-parascene-generation.md](./PLAN-parascene-generation.md) |
| Timeline editing, render, real Hook publish | Non-goals until a later pass |

## Explicit non-goals (still)

No timeline editing, rendering, full generation UI, or real Hook publishing until a later pass intentionally expands scope — and until [generation dependencies](./PLAN-parascene-generation.md) are verified on Parascene.

**Exception / precursor:** verifying that FFmpeg is installed and usable (and assisting when it is not) is **in scope as readiness work** before media pipelines depend on it — see [PLAN-ffmpeg.md](./PLAN-ffmpeg.md).

## Next focus

Implement **Library + sync** per [PLAN-library-sync.md](./PLAN-library-sync.md). Treat Director / Editor / Hook as project-workspace modes that **consume** the library; they do not own downloads or the catalog.
