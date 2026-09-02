# Plan: Refs form for Direct to Blue

Product concept for attaching inputs when Intent is Video to Video or Refs to Video on System Direct to Blue.

Parent lane plan: [PLAN-parascene-blue-direct.md](./PLAN-parascene-blue-direct.md) (Phases C–F). Live vs WIP: [STATUS-new-asset.md](./STATUS-new-asset.md). Wider catch-up: Parascene `_docs/PLAN_video_push_forward.md`.

Where you sit

Project → Generate. Video to Video and Refs to Video are live on Parascene and Direct to Blue. Replicate stays Coming soon until `minimax/h3` is in the Lab catalog. Delivery path: [PLAN-v2v-ref2v.md](./PLAN-v2v-ref2v.md).

The open question is not “does Blue support this?” — it does. The question is how the form attaches references before a request goes out.

Yes — it depends on what kind of ref you have. Blue does not take one mixed “refs” bag. It takes typed slots. The form has to respect that.

Two intents, two shapes

Refs to Video
- Purpose: use these things as references (look, motion, sound).
- Slots: pictures, videos, and optional audio — each as its own list.
- Prompt talks to them by order (Picture 1, Video 1, Audio 1…).
- At least one picture or video is required; audio alone is not enough.
- Primary mode people care about: MiniMax H3 reference-to-video.

Video to Video
- Purpose: drive or edit from this footage.
- Always needs a source / driving video.
- Many modes also need a character or start image; a few are video + prompt only.
- Audio refs are not part of this intent.

What the form must do

- Add refs by kind (image / video / audio), not one anonymous pile.
- Show which slots the chosen mode needs, and clear limits.
- Make prompt tagging obvious (Picture 1 = first attached image).
- Pull from Assets and the timeline where that already feels natural.
- On Direct to Blue, local files are fine — do not force a Creation just to generate.
- After a run, Form still shows which refs were used.

How this maps to the Blue-direct push

Do not invent a parallel sequence. Use C–F from the parent plan:

- C — Shared substrate: media ref picker + upload video (and other kinds) to Blue. This is the real unlock; without it, neither intent leaves Coming soon honestly.
- D — Enable one Video to Video mode on Direct to Blue. First path out of Coming soon; make real clips.
- E — Refs to Video package (typed slots + tagged prompt), starting with MiniMax H3.
- F — Depth later (more modes, prompt helpers, enrichments on familiar intents).

Phase A in plain terms: finish C enough to attach a driving video (and a still when needed), then ship D and make keepers. Phase B: ship E, then widen modes only for what you trust.

Not this plan

- Redesigning Intent / System IA
- Waiting on web create to grow video-ref fields
- Stuffing these intents into timeline-fill continuity (wrong shape)
- Making Replicate the default here
- Shipping every Blue video mode at once
- Promote-to-Creation for local gens

Done when

You can leave Coming soon on Direct to Blue for at least one of these intents, attach the right kinds of refs, submit, and land a local clip — then repeat for Refs to Video without rebuilding the picker.
