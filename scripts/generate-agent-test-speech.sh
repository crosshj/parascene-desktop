#!/usr/bin/env bash
# Refresh the help/test mp3 from public/help/desktop/media/agent-test-speech.wav.
# The wav is the Sparkmonger demo read (~21s). Do not regenerate with `say`.
set -euo pipefail
cd "$(dirname "$0")/.."

WAV="public/help/desktop/media/agent-test-speech.wav"
MP3="public/help/desktop/media/agent-test-speech.mp3"

if [[ ! -f "$WAV" ]]; then
  echo "missing $WAV" >&2
  exit 1
fi

ffmpeg -y -hide_banner -loglevel error -i "$WAV" -codec:a libmp3lame -qscale:a 2 "$MP3"
ffprobe -hide_banner -i "$WAV"
echo "wrote $MP3"
