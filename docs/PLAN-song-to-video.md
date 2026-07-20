# Plan — Song to music video

Project-scoped path: Lab smoke → Director storyboard → Editor AI Fill → render. Related: [PLAN-parascene-generation.md](./PLAN-parascene-generation.md), [PLAN-architecture-principles.md](./PLAN-architecture-principles.md).

## Settled

- [x] AI Fill = vocal isolate + `ltx_a2v` lip sync; keep A1 song audio; discard gen audio
- [x] Two groups per project: **Images** + **Videos**; gens auto-file
- [x] Director owns MV storyboard (main audio + timestamped scenes)
- [x] Lab-first: smoke integrations in-app before product UI
- [x] Lab = Project tab + page only (Director | Editor | Publisher | **Lab**)

## Phase 1 — Project Lab

- [x] Lab tab + `LabLayout` page (`LayoutMode: lab`)
- [x] Shared Lab chrome (module picker, Run/Cancel, status, last result)
- [x] Bootstrap project Images + Videos groups
- [x] Module: Parascene create (image / video) → group + project assets
- [x] Module: upload / seeds
- [x] Module: vocals / speech isolate (A/B play on main audio)
- [x] Module: a2v compose (still + isolate → Videos group)
- [x] Module: clip extend (loop / ping-pong / trim-loop)
- [x] Module: image mutate → Images group + project
- [x] Module: OpenAI raw structured JSON
- [x] Module: lyric align (lyrics + main audio)
- [x] Module: storyboard propose (align + shot catalog → draft scenes)

## Phase 2 — Product

- [ ] Director: main audio, timestamped scenes, storyboard playback
- [ ] Director → Editor handoff (markers / Fill targets)
- [ ] Scene fields ready for auto-Director (`shotType`, lyric ref, prompt hint)
- [ ] Editor AI Fill clip (ghost, re-render, discard gen audio)
- [ ] Timeline extend modes on clips
- [ ] Asset mutate in Editor (not only Lab)
- [ ] Wire Auto-storyboard to Lab propose path

## Later

- [ ] Shot catalog (standard MV shots; AI picks from enum)
- [ ] Forced lyric align + LLM propose as Director “Auto-storyboard”
- [ ] Generate stills from scene notes
- [ ] Library create composer (optional; Lab stays for smoke)
- [ ] First–last frame bridge (platform)
- [ ] Gen without Creation row (product/API decision)
