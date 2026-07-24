#!/usr/bin/env python3
"""Delete stale installers from a rolling GitHub Release after a product rename.

Keeps latest.json and any asset whose name includes "Desktop" (space / dot /
underscore variants from Tauri + GitHub). Removes leftover `Parascene_*` /
`Parascene.app.*` assets from before productName became "Parascene Desktop".

Usage:
  scripts/prune-release-assets.py <tag>

Env:
  GITHUB_REPOSITORY  owner/repo (set by Actions)
  GITHUB_TOKEN       token with contents:write
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request


KEEP_ALWAYS = {"latest.json"}


def api_request(
    url: str,
    token: str,
    method: str = "GET",
    accept: str = "application/vnd.github+json",
) -> bytes:
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": accept,
            "User-Agent": "parascene-desktop-ci",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def should_keep(name: str) -> bool:
    if name in KEEP_ALWAYS:
        return True
    # Current productName artifacts: "Parascene Desktop…", Parascene.Desktop…,
    # Parascene_Desktop…
    return "Desktop" in name or "desktop" in name.lower()


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: prune-release-assets.py <tag>", file=sys.stderr)
        return 2

    tag = sys.argv[1]
    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not repo or not token:
        print("GITHUB_REPOSITORY and GITHUB_TOKEN are required", file=sys.stderr)
        return 2

    api = f"https://api.github.com/repos/{repo}"
    release = json.loads(api_request(f"{api}/releases/tags/{tag}", token))
    deleted = 0
    for asset in release.get("assets", []):
        name = asset["name"]
        if should_keep(name):
            continue
        print(f"Deleting stale asset: {name}")
        api_request(asset["url"], token, method="DELETE")
        deleted += 1

    if deleted == 0:
        print(f"No stale assets on {tag}")
    else:
        print(f"Pruned {deleted} stale asset(s) from {tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
