# Desktop updater (Tauri)

In-app updates use [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/). After a one-time install (Gatekeeper / SmartScreen may still apply while OS builds are unsigned), later versions install via **Help → Check for Updates…** (or the account menu).

## Keys

1. Generate once (do **not** commit the private key):

```bash
mkdir -p .tauri-signing
npx tauri signer generate -w .tauri-signing/updater.key --password '' --ci
```

2. Public key → `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (already set for this repo).
3. Private key → GitHub Actions secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < .tauri-signing/updater.key
# or:
./scripts/set-updater-secret.sh
# optional if the key was created with a password:
# gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Losing the private key bricks updates for existing installs. Keep a secure offline backup of `.tauri-signing/updater.key`.

Local release builds need the same env:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-signing/updater.key)"
npm run build
```

## Release flow

- Continuous builds on `main` publish to the rolling tag `desktop-latest` (non-prerelease, `make_latest: true`) so GitHub’s `/releases/latest` resolves.
- Tag `desktop-v*` for versioned releases (version in `tauri.conf.json` / `package.json` should match).
- CI builds signed updater artifacts (`.app.tar.gz` + `.sig` on macOS, NSIS `.exe` + `.sig` on Windows).
- [`scripts/prune-release-assets.py`](../scripts/prune-release-assets.py) drops stale installers left over after a `productName` rename.
- [`scripts/publish-updater-manifest.py`](../scripts/publish-updater-manifest.py) uploads / merges `latest.json` on the release (prefers newest “Desktop” assets).
- The app checks `https://github.com/crosshj/parascene-desktop/releases/download/desktop-latest/latest.json` (explicit tag; does not depend on GitHub “latest” semantics).

## OS codesign

Separate from updater signing. See [PLAN-os-codesign.md](./PLAN-os-codesign.md).
