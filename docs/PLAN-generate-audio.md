# Plan: Generate speech and music — finish

Provider and www are live. Desktop Generate, Help copy, and suite 12 are written. What is left is live proof, Help media, and teardown.

## Already in (code)

- Parascene Generate TTS / music on server 1 (`replicateSpeech` / `replicateMusic`)
- Voice lists from capabilities (Gemini full list; MiniMax + Custom → `voice_id`; emotion)
- Voice train via `replicateVoiceTrain` (API path wired; not in first-run)
- Help: `public/help/generate-audio.html`
- Agent: `generation.audio`, `timeline.place` (A1/A2)
- Suite 12 written. Seed `28006` stays.

BYO Replicate TTS/music already worked. Direct-to-Blue audio stays `coming_soon`. Suite 06 / `audio.html` (disk speech → A2V) is unchanged.

## Left

Live smoke (cheap, `@awesome`, already signed in)

- Speech: Gemini Flash TTS, Kore, short line → audio Creation → local file in Assets
- Music: Lyria 3, short prompt → same
- Check: 2 + 10 credits, `media_type: audio`, plays in desktop

Suite 12

- One file: `integration/12-audio-generate.integration.test.ts` against `npm run dev`
- Live Parascene. Do not run 05–07 in the same sitting
- Own project: Kore + Puck lines, Lyria bed; speech on A1, score on A2
- Teardown this-run / `agent-test-*`. Fail if `28006` is gone
- ~14 credits (2+2+10)

Help media (missing until 12 runs)

- Screens: `editor-generate-audio-prompt.png`, `…-result.png`, `…-timeline.png`
- Clips: `generate-audio-kore.mp3`, `…-puck.mp3`, `…-lyria.mp3`
- After green: open the article. Fix copy only if the live UI diverged

Caps fixture

- If live server 1 fields differ, refresh `docs/parascene-product-server-caps.json`

Not this finish (API exists; skip unless something breaks)

- MiniMax Custom / live voice-train (175 credits)
- Direct-to-Blue TTS/music
- Hand-off into A2V / suite 06
- Identity suites 08–11

## Done when

- Suite 12 green on live Parascene
- Help page has the three live shots and three clips
- `@awesome` Library still has unpublished seed `28006`
