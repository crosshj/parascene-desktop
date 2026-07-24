#!/usr/bin/env bash
# Print markdown body for the rolling desktop-latest GitHub Release.
# Usage: scripts/desktop-latest-release-notes.sh [semver]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(bash "$ROOT/scripts/app-version.sh")"
fi

MAC_DMG="Parascene Desktop_${VERSION}_aarch64.dmg"
WIN_EXE="Parascene Desktop_${VERSION}_x64-setup.exe"

cat <<EOF
Unsigned desktop builds from \`main\` (updated on each qualifying push).

### Download (first install)

| Platform | File to download |
| --- | --- |
| **macOS** (Apple Silicon) | \`${MAC_DMG}\` |
| **Windows** (x64) | \`${WIN_EXE}\` |

Ignore the other assets (\`.sig\`, \`.app.tar.gz\`, \`latest.json\`) — those are for **in-app updates**, not manual install.

### macOS install

1. Download **\`${MAC_DMG}\`**.
2. Open the DMG → drag **Parascene Desktop** to Applications.
3. Clear Gatekeeper quarantine (unsigned builds):

\`\`\`bash
xattr -cr "/Applications/Parascene Desktop.app"
\`\`\`

### Windows install

1. Download **\`${WIN_EXE}\`**.
2. Run the installer. SmartScreen may warn on unsigned builds — choose **More info** → **Run anyway**.
3. WebView2 is installed automatically if missing.

Already installed? Use **Help → Check for Updates…** in the app instead of re-downloading.
EOF
