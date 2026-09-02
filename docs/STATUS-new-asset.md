# New Asset — Live vs WIP

Source: `src/layouts/editor/previewIntent.ts` + `docs/parascene-product-server-caps.json`

Legend: ✅ live · ⏳ coming soon · — not applicable

## Servers (prerequisites)

- [x] **Parascene** — OAuth login + credits; outputs sync to Creations
- [x] **Direct to Blue** — Settings → Blue credentials (BYO); local-only output
- [x] **Replicate** — Settings → API token + Lab-enabled models; local-only output

## Intents

### Text to Image
- [x] Generate to Assets — Parascene (Blue + Replicate + Replicate Pro + PixelLab), Blue Direct, Replicate
- [ ] Place on timeline (coming soon for stills)
- [x] Parascene · Blue Direct · Replicate

### Image to Image
- [x] Generate to Assets — Parascene (Blue + Replicate + Replicate Pro)
- [ ] Place on timeline
- [x] Parascene
- [ ] Blue Direct · Replicate

### Text to Video
- [x] Place / Drag → timeline generate — all servers
- [ ] Generate to Assets (all servers)
- [x] Parascene · Blue Direct · Replicate

### Image to Video
- [x] Place / Drag → timeline generate — all servers
- [ ] Generate to Assets (all servers)
- [x] Parascene · Blue Direct · Replicate

### Audio to Video
- [x] Place / Drag → timeline generate — Parascene, Blue Direct
- [ ] Replicate
- [ ] Generate to Assets (— timeline only)

### Video to Video
- [x] Place / Drag → timeline generate — Parascene, Blue Direct
- [ ] Generate to Assets
- [ ] Replicate (`minimax/h3` not in Lab catalog)

### Refs to Video
- [x] Place / Drag → timeline generate — Parascene, Blue Direct (MiniMax H3)
- [ ] Generate to Assets
- [ ] Replicate (`minimax/h3` not in Lab catalog)

### Text to Music
- [ ] All servers
- [ ] Generate to Assets (— assets only, nothing wired)

### Text to Speech
- [ ] All servers
- [ ] Generate to Assets (— assets only, nothing wired)

## Cross-cutting gaps

- [ ] Generate to Assets for video intents (T2V, I2V, …)
- [ ] Place on timeline for stills (T2I, I2I)
- [ ] Motion match on I2V (Replicate only today)
- [ ] Replicate Audio to Video
- [ ] I2I on Blue Direct and Replicate
- [ ] V2V / Refs to Video on Replicate (`minimax/h3` missing from Lab catalog)
- [ ] Music / Speech (not in product server caps)
- [x] Wire server 1 `replicate` / `replicatePro` / `pixelLabImage` on Parascene stills
- [x] Wire server 6 native `text2image` / `image2image` (Parascene Blue stills via credits)