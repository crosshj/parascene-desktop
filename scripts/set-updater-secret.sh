#!/usr/bin/env bash
# One-time: upload the local updater private key to GitHub Actions secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$ROOT/.tauri-signing/updater.key"
if [[ ! -f "$KEY" ]]; then
  echo "Missing $KEY — generate with:"
  echo "  npx tauri signer generate -w .tauri-signing/updater.key --password '' --ci"
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI (gh), then re-run this script."
  exit 1
fi
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo crosshj/parascene-desktop < "$KEY"
echo "Set TAURI_SIGNING_PRIVATE_KEY on crosshj/parascene-desktop"
