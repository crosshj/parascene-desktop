#!/bin/bash
# Prime Demucs htdemucs model (Lab Vocals / a2v). Safe to re-run.
set -euo pipefail

DEMUCS="${HOME}/.local/bin/demucs"
if [[ ! -x "$DEMUCS" ]]; then
  DEMUCS="${HOME}/.local/share/demucs-venv/bin/demucs"
fi
if [[ ! -x "$DEMUCS" ]]; then
  echo "demucs not found — install first (see LOCAL_TOOLS.md)" >&2
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/demucs-prime.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# 1s of silence — enough to load weights and write stems without needing real audio.
ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 "$TMP/silence.wav" >/dev/null 2>&1

echo "Running demucs -n htdemucs (downloads/loads model if needed)…"
"$DEMUCS" -n htdemucs --two-stems vocals -o "$TMP/out" "$TMP/silence.wav"
echo "OK — htdemucs primed. Model cache: ~/.cache/torch/hub/checkpoints/"
ls -lh ~/.cache/torch/hub/checkpoints/955717e8-8726e21a.th 2>/dev/null || true
