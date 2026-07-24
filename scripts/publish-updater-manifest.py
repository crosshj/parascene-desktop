#!/usr/bin/env python3
"""Rebuild latest.json on a GitHub Release from uploaded Tauri updater assets.

Safe to run from both macOS and Windows workflows: merges platforms already
attached to the release (last writer wins with the full asset set).

Usage:
  scripts/publish-updater-manifest.py <tag> <semver> [notes]

Env:
  GITHUB_REPOSITORY  owner/repo (set by Actions)
  GITHUB_TOKEN       token with contents:write
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def api_request(url: str, token: str, accept: str = "application/vnd.github+json") -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": accept,
            "User-Agent": "parascene-desktop-ci",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def download_asset(asset: dict, token: str, dest: Path) -> None:
    data = api_request(asset["url"], token, accept="application/octet-stream")
    dest.write_bytes(data)


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: publish-updater-manifest.py <tag> <semver> [notes]",
            file=sys.stderr,
        )
        return 2

    tag = sys.argv[1]
    version = sys.argv[2]
    notes = sys.argv[3] if len(sys.argv) > 3 else ""

    repo = os.environ.get("GITHUB_REPOSITORY")
    token = os.environ.get("GITHUB_TOKEN")
    if not repo or not token:
        print("GITHUB_REPOSITORY and GITHUB_TOKEN are required", file=sys.stderr)
        return 2

    api = f"https://api.github.com/repos/{repo}"
    download_base = f"https://github.com/{repo}/releases/download/{tag}"

    release = json.loads(api_request(f"{api}/releases/tags/{tag}", token))
    assets = {a["name"]: a for a in release.get("assets", [])}

    platforms: dict[str, dict[str, str]] = {}

    # macOS: Parascene Desktop.app.tar.gz + .sig (Apple Silicon CI)
    for name, asset in assets.items():
        if name.endswith(".app.tar.gz"):
            sig_name = f"{name}.sig"
            if sig_name in assets:
                platforms["darwin-aarch64"] = {
                    "url": f"{download_base}/{urllib.parse.quote(name)}",
                    "_sig": sig_name,
                }
            break

    # Windows NSIS: *-setup.exe + .sig
    for name, asset in assets.items():
        if name.endswith("-setup.exe"):
            sig_name = f"{name}.sig"
            if sig_name in assets:
                platforms["windows-x86_64"] = {
                    "url": f"{download_base}/{urllib.parse.quote(name)}",
                    "_sig": sig_name,
                }
            break

    # Merge prior latest.json so a single-platform run does not wipe the other.
    if "latest.json" in assets:
        with tempfile.TemporaryDirectory() as tmp:
            old_path = Path(tmp) / "latest.json.old"
            try:
                download_asset(assets["latest.json"], token, old_path)
                old = json.loads(old_path.read_text(encoding="utf-8"))
                for key, value in (old.get("platforms") or {}).items():
                    if key in platforms:
                        continue
                    if (
                        isinstance(value, dict)
                        and value.get("url")
                        and value.get("signature")
                    ):
                        platforms[key] = {
                            "url": value["url"],
                            "signature": value["signature"],
                        }
            except (urllib.error.URLError, json.JSONDecodeError, OSError) as exc:
                print(f"warning: could not merge existing latest.json: {exc}", file=sys.stderr)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        for entry in platforms.values():
            sig_name = entry.pop("_sig", None)
            if not sig_name:
                continue
            sig_path = tmp_path / sig_name
            download_asset(assets[sig_name], token, sig_path)
            entry["signature"] = sig_path.read_text(encoding="utf-8").strip()

        manifest = {
            "version": version,
            "notes": notes,
            "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "platforms": platforms,
        }

        out = tmp_path / "latest.json"
        out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(manifest, indent=2))

        if not platforms:
            print(
                "No updater assets yet; uploaded empty platforms (next OS job will fill).",
                file=sys.stderr,
            )

        subprocess.check_call(
            [
                "gh",
                "release",
                "upload",
                tag,
                str(out),
                "--repo",
                repo,
                "--clobber",
            ],
            env={**os.environ, "GH_TOKEN": token},
        )

    print(f"Published latest.json for {tag} (v{version})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
