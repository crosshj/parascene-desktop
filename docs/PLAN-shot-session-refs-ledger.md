# Plan: Shot session, references, and project ledger

Aspiration. Not the near-term leftover (last Videos Remove, Help map). Complements BACKLOG #1 #2 #4–#10 #18 and PLAN-image-compose-edit.

Problem

- Too much lands as a visible Parascene Creation because the credits path needs a fetchable URL.
- Too much working material stays in Assets after the clip is on the timeline.
- Images/Videos cabinets are modality buckets. Assets expands members, so a start frame looks like inventory.
- A fetchable URL is a store. A Creation is a social object. Do not conflate them.

Direction

- Model the project on Parascene as a real container, not a pile of Library tiles.
- Model references as groups inside that project. Cover is the asset. Internals are history (start/end frames, takes, clips that came from them).
- Desktop Assets shows one reference tile. Dig in to reuse a prior start frame. That is inspect, not ungroup. Ungroup only on explicit promote.
- Direct to Blue / Replicate use the same shape locally. Do not mint Creations so a local-only ref can “be a group.”
- Publish stays deliberate. Scratch stays inside the project (or ephemeral). Never a home-Library still just because generate needed bytes.

Objects

- Project — container. Local-first working copy. Parascene project is the credits-lane store, not the social feed.
- Reference bundle — purpose group. Reusable (person, plate, setup). Accretes frames and videos. The durable exception to “throw the still away.”
- Shot / ShotSpec — one production object. Intent, refs, start/end candidates, chosen frames, clip. Timeline gets the accepted clip. Bundle gets frames you might want again.
- Chat history — part of the project, not a Creation. How the shot was walked. Travels with the project the way the ledger does.
- Ledger row — born when the job starts. Survives the file.

First slice — talk-only chat

- Editor already has a hidden Assistant pane (`SHOW_EDITOR_ASSISTANT`, `AssistantPane`). It stubs `ask` and shows fake proposals. That is the window.
- Step 1 is a real LLM in that pane. No eyes (does not see Assets / timeline / frames). No ears (no project audio). No arms (no tools, no generate, no cleanup, no ShotSpec writes).
- It can still talk, and it can help rewrite prompts.
- Do not revive `src/capabilities/index.ts` stubs (GUIDE-service-and-forms). Wire through Settings + `service_invoke` like other long work.
- History can stay local for this slice. Project-on-Parascene chat sync comes later.
- Done when: flip the pane on, type, get a useful reply, iterate a generate prompt. Fake proposal cards can go.

Shot session (the wizard)

- After talk-only: UI walks intent, then iterates the starting screen, then makes the video.
- Chat is the first skin. Same commands either way: createShot, attachReference, generateFrame, setFirstFrame, generateVideo, selectCandidate, addShotToTimeline, cleanup.
- Chat interprets. App mutates real objects. Every turn shows what changed and is undoable.
- Chat drives timeline, preview, Assets. It does not replace them.
- A dedicated wizard later is a skin over the same commands once the steps stop moving.

Chat history on the project

- Persist the durable session: user turns, tool calls, shot ids, accepted/rejected, cost rows. That is enough to reopen the shot on another machine or later.
- Do not persist raw model dumps, local paths, or in-progress draft context as Parascene social objects. Drafts stay local until the session commits (or a quiet project sync).
- Same rule as the ledger: project metadata, not a Library tile. GUIDE-architecture-principles still stands — assistant drafts default local until they need to travel.
- Chat cost (LLM tokens) can be a ledger line too, separate from gen credits / Replicate / Blue.

Throw away vs keep

- Throw-away-as-you-go is transport, not taste. Safe now: ffmpeg extracts, ephemeral still_url, fill/stretch JPEGs that exist only as a URL, a start-frame candidate the user already replaced, anything never pinned to a ref.
- Keep while the session is open: current start/end, other candidates in this shot, anything already in a reference group.
- On accept clip: drop session scratch that is not in a ref. Do not drop a still because a clip exists if it is a pinned reference.
- True throwaways (one-shot neighbor extract, rejected take) do not get filed into a ref “just in case.”

Cleanup

- Executable project task, reviewable, not a silent vacuum.
- Sweeps stragglers: orphan extracts, framed stills not in a ref and not on a live shot, empty cabinet covers, local leftovers after a Parascene gen.
- Run after accept clip or on demand. Safety net, not the strategy.

Ledger

- Deleting the file must not delete the spend.
- Row: when, shot/session, lane, model, prompt, durable input refs, quoted cost, actual cost if known, outcome (succeeded / failed / accepted / discarded).
- Three currencies stay separate: Parascene credits, Replicate dollars, Blue-direct. Project running totals plus per-shot subtotals.
- Lives on the project (local, later project metadata). Not a stack of Creations.

Lanes (unchanged)

- Parascene: ephemeral or project-grouped store for inputs. Visible Creation only on publish.
- Direct to Blue / Replicate: local-only. Same lifecycle and ledger. Same nested ref shape.

Done when

- A shot can be walked in chat from intent → start-screen loop → clip without dumping stills into Assets or Parascene home.
- Reusing a prior start frame is “open the ref,” not an ungrouped Images tile.
- Accept clip + cleanup leave refs and the ledger; transport and rejects are gone.
- Project can answer what was tried and what it cost after the artifacts are gone.
- Reopening the project restores the shot chat (durable turns), not a blank assistant.

Not this pass

- Last Videos cabinet Remove, Help leftover (those stay the near-term hole).
- Director song-to-video Phase 2.
- Full character/environment UI (chat + groups first).
- Promote local gens to social Creations (still explicit, later).
