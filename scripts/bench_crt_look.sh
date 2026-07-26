#!/usr/bin/env bash
# Bench FFmpeg CRT-like filter vs encode-only (see docs/crt-look-bench.md).
set -euo pipefail
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=720x1280:rate=30" -t 3 \
  -c:v libx264 -pix_fmt yuv420p "$TMP/src.mp4"
FILTER="split[b][g];[g]gblur=sigma=2[glow];[b][glow]blend=all_mode=screen:all_opacity=0.1,format=rgba,rgbashift=rh=1:bh=-1,format=yuv420p,noise=alls=5:allf=t+u,vignette=angle=0.57,geq=lum='lum(X\,Y)*(1-0.48*0.5*(1+sin(Y*2*PI/2)))':cb='cb(X\,Y)':cr='cr(X\,Y)',format=yuv420p"
echo "=== filter-only (-f null) ==="
/usr/bin/time -p ffmpeg -y -hide_banner -loglevel error -i "$TMP/src.mp4" -an -vf "$FILTER" -f null -
echo "=== encode-only (no CRT) ==="
/usr/bin/time -p ffmpeg -y -hide_banner -loglevel error -i "$TMP/src.mp4" -an \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -profile:v baseline -bf 0 -f null -
echo "=== filter+encode ==="
/usr/bin/time -p ffmpeg -y -hide_banner -loglevel error -i "$TMP/src.mp4" -an -vf "$FILTER" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -profile:v baseline -bf 0 -f null -
