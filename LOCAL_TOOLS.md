# Local tools (macOS)

Parascene Desktop calls a few **local binaries** for Lab and Editor media work. They are not bundled in the app today — install them on the Mac, then re-check status in **Settings → Local tools** (or re-open Lab).

| Tool | Required for | Install |
|------|----------------|---------|
| **FFmpeg** | Audio slice, clip extend, thumbs from video/audio, timeline reverse/merge/render, beat detect | `brew install ffmpeg` |
| **Demucs** (+ Python 3) | Lab **Vocals / slice** (vocals mode) and **a2v compose** vocal stems | See below |
| **Whisper** (+ Python 3) | Lab **Lyric align** local transcription (optional; OpenAI API also works) | See below |
| **OpenAI API key** | Lab **OpenAI raw**, **Lyric align** (lyric matching), and **Storyboard propose** | Paste in **Settings** (stored on this Mac only) |
| **Parascene login** | Sync, create, groups, cloud seeds | In-app **Log in with Parascene** |

Dev machine extras (to build the app): Node 20+, Rust via rustup, Xcode CLT — see [README.md](README.md).

---

## FFmpeg

```bash
brew install ffmpeg
ffmpeg -version
```

The app also looks in `/opt/homebrew/bin` and `/usr/local/bin` when launched from Finder (GUI apps often have a thin `PATH`).

Without FFmpeg, Lab isolate/extend and many Editor media actions fail with an install hint.

---

## Demucs (vocals isolate)

[Demucs](https://github.com/facebookresearch/demucs) separates vocals from a mix (Python + PyTorch). Lab **Vocals / slice** runs Demucs on the **full track once**, caches the vocals stem, then takes FFmpeg time slices from that stem (and from the mix) for A/B and a2v.

### Install (recommended)

```bash
# Needs Python 3.9+ on PATH as `python3`
python3 -m pip install --user demucs
```

First install downloads **PyTorch** and model weights (large; needs network). User scripts usually land in:

```text
~/Library/Python/3.x/bin/demucs
~/.local/bin/demucs
```

Ensure that directory is on your shell `PATH`, **or** use **Settings → Local tools → Install demucs** so the app can run the same `pip install --user` and resolve those locations even when Finder’s `PATH` is empty.

### Verify

```bash
which demucs
demucs --help
```

In the app: Settings → Local tools should show **Demucs: ready**.

### If install fails

- Upgrade pip: `python3 -m pip install --upgrade pip`
- Apple Silicon: use a current `python3` from python.org or Homebrew (`brew install python`)
- Disk / network: Demucs + torch is multi‑GB
- **NumPy 2 vs Torch:** if `demucs --help` errors about NumPy 1.x modules, pin with  
  `python3 -m pip install --user 'numpy<2'`

There is no small pure-Rust substitute with the same quality. Without Demucs, Lab can still **slice** full-mix audio; **a2v** stays gated until Demucs is available.

---

## Whisper (local lyric transcription)

[openai-whisper](https://github.com/openai/whisper) runs speech-to-text locally. Lab **Lyric align** can use it instead of the OpenAI Whisper API for step 2 (transcription). Step 3 (mapping your lyrics onto segments) still uses the OpenAI API key.

### Install

```bash
python3 -m pip install --user openai-whisper
```

First install downloads **PyTorch** and model weights (large; needs network). The CLI is usually:

```text
~/Library/Python/3.x/bin/whisper
~/.local/bin/whisper
```

### Verify

```bash
which whisper
whisper --help
```

In the app: Settings → Local tools should show **Whisper: ready**.

### If install fails

- Same Python / pip / NumPy notes as Demucs above
- Without local Whisper, use **OpenAI Whisper API** in Lyric align (still needs API key for lyric matching)

---

## OpenAI

Optional cloud key for Lab LLM steps and cloud Whisper transcription. Not required for Parascene create / Library sync.

---

## Re-check after install

1. Quit and reopen Parascene (or click **Re-check** in Settings → Local tools).
2. Confirm FFmpeg / Demucs show ready.
3. Retry **Vocals / slice** or **a2v compose**.
