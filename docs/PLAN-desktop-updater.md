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

- Tag `desktop-v*` (version in `tauri.conf.json` / `package.json` should match).
- CI builds signed updater artifacts (`.app.tar.gz` + `.sig` on macOS, NSIS `.exe` + `.sig` on Windows).
- [`scripts/publish-updater-manifest.py`](../scripts/publish-updater-manifest.py) uploads / merges `latest.json` on the release.
- The app checks `https://github.com/crosshj/parascene-desktop/releases/latest/download/latest.json` (latest **non-prerelease**).

`desktop-latest` also gets updater assets + `latest.json` for continuous main builds, but the in-app endpoint follows GitHub’s “latest” stable release.

## OS codesign

Separate from updater signing. See [PLAN-os-codesign.md](./PLAN-os-codesign.md).
