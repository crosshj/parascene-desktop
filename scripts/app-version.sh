#!/usr/bin/env bash
# Resolve app semver from src-tauri/tauri.conf.json (used by CI release steps).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 - <<PY
import json
with open("${ROOT}/src-tauri/tauri.conf.json", encoding="utf-8") as f:
    print(json.load(f)["version"])
PY
