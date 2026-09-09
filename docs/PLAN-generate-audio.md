# Plan: Generate speech and music — finish

Suite 12 is green. Flash TTS + disk speech on A1/A2, Publisher mix loud / quiet / loud. Help shots and the Flash clip are current. Both tiles use the in-app audio icon. The Flash tile is tinted and labeled FLASH (Parascene SVG cover is skipped). Seed `28006` stays.

## In

- Parascene Generate TTS / music on server 1 (`replicateSpeech` / `replicateMusic`)
- Voice lists from capabilities (Gemini full list; MiniMax + Custom → `voice_id`; emotion)
- Voice train via `replicateVoiceTrain` (API path wired; not in first-run)
- Help: `generate-audio.html` (journey) and `audio-models.html` (Topics, names only, no suite)
- Agent: `generation.audio`, `timeline.place` (A1/A2), `publisher.render`
- Board preview skips audio `.svg` thumbs (`creationPreviewUrl`)
- Asset color chips from the model (stamp or Parascene meta): FLASH, LYRIA, MM SPEECH, MM MUSIC

BYO Replicate TTS/music already worked. Direct-to-Blue audio stays `coming_soon`. Suite 06 / `audio.html` (disk speech → A2V) is unchanged.

## Not this finish

- Live Lyria / MiniMax Music / second TTS speaker (the mix proof uses one generate + one disk clip)
- MiniMax Custom / live voice-train (175 credits). Never from suite 12 or generation.audio.
- Direct-to-Blue TTS/music
- Hand-off into A2V / suite 06
- Identity suites 08–11
- Refresh `docs/parascene-product-server-caps.json` only if live server 1 fields differ

## Done when

- Suite 12 green: Flash generate, A2 after a gap, Publisher mix is loud / quiet / loud
- Help page has the three live shots and the Flash clip
- `@awesome` Library still has unpublished seed `28006`
