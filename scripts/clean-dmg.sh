#!/usr/bin/env bash
# Strip visible volume-icon junk from Tauri DMGs so Finder shows only App + Applications.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DMG_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

shopt -s nullglob
DMGS=("$DMG_DIR"/Parascene_*.dmg)
if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "No Parascene DMG found in $DMG_DIR" >&2
  exit 1
fi

# Prefer the most recently modified build.
DMG_PATH="$(ls -t "${DMGS[@]}" | head -1)"
DMG_NAME="$(basename "$DMG_PATH")"
WORK_DIR="$(mktemp -d /tmp/parascene-dmg-clean.XXXXXX)"
RW_PATH="$WORK_DIR/rw.dmg"
MOUNTPOINT="$WORK_DIR/mount"

cleanup() {
  if [[ -d "$MOUNTPOINT" ]]; then
    hdiutil detach "$MOUNTPOINT" -quiet 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "Cleaning DMG: $DMG_PATH"
mkdir -p "$MOUNTPOINT"

hdiutil convert "$DMG_PATH" -format UDRW -o "$RW_PATH" -quiet
hdiutil attach "$RW_PATH" -readwrite -noverify -noautoopen -nobrowse -mountpoint "$MOUNTPOINT" -quiet

# Tauri may leave either the dotfile or a visible VolumeIcon.icns
rm -f "$MOUNTPOINT/.VolumeIcon.icns" "$MOUNTPOINT/VolumeIcon.icns" "$MOUNTPOINT/icon.icns"
# Clear custom-icon bit on the volume itself
if command -v SetFile >/dev/null 2>&1; then
  SetFile -a c "$MOUNTPOINT" 2>/dev/null || true
fi

# Hide any AppleDouble leftovers
find "$MOUNTPOINT" -name '._*' -delete 2>/dev/null || true

hdiutil detach "$MOUNTPOINT" -quiet
hdiutil convert "$RW_PATH" -format UDZO -imagekey zlib-level=9 -o "$DMG_PATH" -quiet -ov

echo "Clean DMG ready: $DMG_PATH"
