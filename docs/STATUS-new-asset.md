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
- [x] Place / Drag → timeline generate — Parascene
- [ ] Generate to Assets
- [ ] Blue Direct · Replicate

### Refs to Video
- [ ] All servers (not in live Parascene server 6 methods)
- [ ] Generate to Assets
- [ ] Place on timeline

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
- [ ] I2I / V2V on Blue Direct and Replicate
- [ ] Refs to Video on product path (`reference2video` absent from live server 6)
- [ ] Music / Speech (not in product server caps)
- [x] Wire server 1 `replicate` / `replicatePro` / `pixelLabImage` on Parascene stills
- [x] Wire server 6 native `text2image` / `image2image` (Parascene Blue stills via credits)