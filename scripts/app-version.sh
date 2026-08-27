#!/usr/bin/env bash
# Resolve app semver from package.json (CI release + tauri.conf.json source).
#
# --sync-cargo: after rust-cache, stamp that semver into Cargo.toml / Cargo.lock
# on this runner so the build embeds the product version. Repo stays at 0.0.0.
#
# Relative paths after cd so Windows Python (from Git Bash) can open the files.
set -euo pipefail
cd "$(dirname "$0")/.."

SYNC_CARGO=0
if [[ "${1:-}" == "--sync-cargo" ]]; then
  SYNC_CARGO=1
fi

VERSION="$(
  python3 - <<'PY'
import json
with open("package.json", encoding="utf-8") as f:
    print(json.load(f)["version"])
PY
)"

if [[ "$SYNC_CARGO" -eq 1 ]]; then
  APP_VERSION="$VERSION" python3 - <<'PY'
from pathlib import Path
import os
import re

version = os.environ["APP_VERSION"].strip()
if not version:
    raise SystemExit("Empty package.json version")

toml = Path("src-tauri/Cargo.toml")
text = toml.read_text(encoding="utf-8")
text, n = re.subn(
    r'(?m)^version = "[^"]*"',
    f'version = "{version}"',
    text,
    count=1,
)
if n != 1:
    raise SystemExit("Could not patch [package] version in Cargo.toml")
toml.write_text(text, encoding="utf-8")

lock = Path("src-tauri/Cargo.lock")
lines = lock.read_text(encoding="utf-8").splitlines(keepends=True)
out = []
i = 0
patched = False
while i < len(lines):
    line = lines[i]
    out.append(line)
    if line.strip() == 'name = "parascene-desktop"' and i + 1 < len(lines):
        nxt = lines[i + 1]
        if nxt.startswith("version = "):
            out.append(f'version = "{version}"\n')
            i += 2
            patched = True
            continue
    i += 1
if not patched:
    raise SystemExit('Could not patch parascene-desktop version in Cargo.lock')
lock.write_text("".join(out), encoding="utf-8")
print(f"Synced Cargo package version to {version} for this build", flush=True)
PY
fi

printf '%s\n' "$VERSION"
