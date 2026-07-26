# CRT Look performance notes

Measured on a local Mac with FFmpeg 8.x, synthetic **3s 720×1280@30** clip:

| Path | Wall (s) | Notes |
|---|---|---|
| CRT-like filter graph → `-f null` | **6.64** | Dominates (~2.2× realtime) |
| Encode only (Baseline x264 veryfast) → null | **0.43** | ~0.14× realtime |
| Filter + encode → null | **6.93** | Filter-bound |

Conclusion: the CPU Look graph (blur / blend / geq / noise) is the bottleneck, not x264. A GPU CRT path that avoids that graph should reclaim most of the wait.

GPU path notes:
- Uses **wgpu** (Metal / Vulkan / DX12) with WGSL presets TV / Afterglow / Broadcast.
- Adapters are **probed for working CPU readback** before use (some Metal discrete GPUs accept map callbacks without completing queue writes).
- No GPU / failed probe → FFmpeg **TV** CPU fallback; Afterglow / Broadcast require GPU.
- Looks apply only during Publisher **render** (baked into the output MP4), not as a player overlay.
- GPU Look path **stream-copies** segment concat (no intermediate baseline x264), then shades + encodes once.

Re-run:

```bash
# From repo root — adjust FILTER if TV defaults change
./scripts/bench_crt_look.sh
```
