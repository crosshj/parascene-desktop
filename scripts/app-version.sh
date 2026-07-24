#!/usr/bin/env bash
# Resolve app semver from src-tauri/tauri.conf.json (used by CI release steps).
# Use a relative path after cd so Windows Python (invoked from Git Bash) works —
# bash `pwd` yields /d/... paths that native Windows Python cannot open.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json
with open("src-tauri/tauri.conf.json", encoding="utf-8") as f:
    print(json.load(f)["version"])
PY
