# Plan note

The original Phase 0 plan lived at this path and drove scaffolding. Implementation decisions applied:

- **Auth:** public/native OAuth client — PKCE-only token exchange with Parascene (no `psn_` in the app or a local bridge).
- **SDK:** `src/sdk/parascene.ts` is the only path for Parascene API calls.
- **Theme:** deferred; functional dark shell only.
- **Stack:** Tauri 2 + React + TypeScript, flat layout at repo root.
