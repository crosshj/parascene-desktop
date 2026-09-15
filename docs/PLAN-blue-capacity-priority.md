# Plan: Blue capacity, fairness, and wait

Blue is one GPU. Desktop, www, Lab, and Direct to Blue all share it. Today that looks like an API that failed. It is a scarce machine. Illustrated: [blue-capacity-scenarios.html](./blue-capacity-scenarios.html) (order + wait). Related: [GUIDE-generation-lanes.md](./GUIDE-generation-lanes.md), [GUIDE-generate-wait.md](./GUIDE-generate-wait.md). Product copy must not brand the credits path “Blue.”

Execute this file in order. In-line vs generating is done. Occupancy is done. Slider is done. No per-person: Blue does not get `person`, does not fair-share by account, and does not wait on identity. One line, numbers only.

What is still wrong
- Desktop cancel stops the local waiter. It does not pull the job off Blue. No per-job dequeue (operator Comfy interrupt is everyone).
- Stickiness can run a Lab still before a waiting video if the checkpoint is already loaded.

Locked (A)
One line. Highest Credits Boost first, FIFO among equal boosts. Running job is not skipped. Later higher boost can jump pending. Job price is list `cost` plus boost. Charge that total at create. Fail or dequeue-before-start: refund as today. No person on the job.
Product slider is Credits Boost on top of this method’s list `cost`, in 0.5 steps. Rank by boost, not by list price — a still at +0.5 sits ahead of a video at +0. They cannot send a price under list — UI floor and Parascene reject. Total cap 50 unless `cost` is already higher. Two sticky boosts (image, video). Default is list (boost 0). Slider ends do not promise wait time. A still at max boost is their problem. Saturated equal boosts are FIFO; eta at this boost must say so. Way out is Replicate (leave this GPU), not a bigger slider.
Direct/Lab: no slider, no credits, no list floor. Boolean always-next: off = max 0; on = max > 50. Sticky off. FIFO among ons. Off sits behind anyone paying list. Can starve the credits path when on — say so.

Execute
- Done (www + desktop): paint in line vs generating from poll. Finish timeout only once `running`.
- Done (www + desktop + Direct): Blue occupancy query. Busy → occupancy, then send or don’t start. No slider. No Replicate CTA; they already have that lane.
- Next: pending dequeue. Not per-person.

Done — in line vs generating
After enqueue, two states. Poll keeps them all the way to the UI. Fail only for real breakage. Do not convert 202-busy into a failed Creation.
- In line — `pending` / www `queued` (and `creating` until the first generating poll). Place if we have it. Not a gen timer. Do not expire this on the finish clock.
- Generating — `running` / `processing`. Then the finish clock and “Generating…” are honest.
Status lines match www: QUEUED, Generating…, TIMED OUT. GUIDE-generate-wait: finish clock starts at first `running` / `processing`.

Done — occupancy
Peek is a read of the live line before there is a job. No `job_id`. Nothing enters the line. No Creation. No credits. Not a reservation — the line can move; enqueue peeks again.
Blue query is live. www consumes it. Parascene passes the same payload through `POST /api/create/query` (already no charge, no DB write, `{ method, args }` → server) so desktop on the product path can too. Direct to Blue: same Blue query.
When: the moment they would have created, on methods that hit this GPU. Idle → send. Busy → show occupancy; they send (sit in line) or don’t start. Occupancy is not operator `/status`. Do not add a Use Replicate control — they pick that lane themselves.
Returns (honest ranges ok): existing `supported` / `cost`, plus idle or running still/video + family (not other people’s prompts), `ahead`, `eta_s` at list (`cost`), anonymous pending maxes, `highest_max`, `running_eta_s`. “You’ll be Nth, ~T min” is success.
Product copy: “This server is busy.” Direct: “Blue is busy,” no credits row. Place and wait live in the sentence; stats are only what is running now (and credits on the product path). Don’t start is not `failed`.

Then — slider
Idle → send at list. Wait → occupancy modal is the negotiate step. Slider lives there, not on the form. One occupancy query; dragging does not call the network.
Query returns enough to show the live line by priority: anonymous pending maxes (or a max→ahead/eta step curve), running job, `highest_max`, list `cost`. No people, no prompts. `highest_max` alone is not enough — at 12 you might jump three list jobs and still sit behind a 50. Client places the proposed max on that snapshot. Confirm peeks again if the line moved; don’t silently take a worse slot.
Slider is Credits Boost added to list `cost`, 0.5 steps, total cap 50 (see Locked). Rank by boost. Charge list plus boost at create. Sticky image and video boosts.
Direct/Lab: always-next boolean on that same modal, no credits slider. Blue still owns enqueue. Client preview is the snapshot lookup, not a second scheduler.

Done — slider
Idle sends at list. Wait → modal slider from method `cost` to 50 on a query snapshot (priority of the current line). Sticky image max and sticky video max. Named price charged at create. Cannot undercut list. Direct/Lab always-next (beats 50), no credit bid. Later higher max can jump pending. Assets queued tiles use the same upper-right clock vs spinner as timeline clips.

Later
- Pending dequeue by `job_id`. Status `cancelled`, not `failed`. Creation back to the form. Credits never charged, or refunded if held. Running: do not Comfy-interrupt the whole machine.
- Maybe: pause Lab when product is backed up; charge Blue only if it actually runs; operator freeze a lane.

Contract (Blue)
- Query (no job): occupancy plus anonymous pending maxes, `highest_max`, `running_eta_s`. Not a query per slider tick.
- Enqueue: `max_bid`. Product: required, `>= cost`, cap 50 unless `cost` is higher. Parascene rejects under list. Direct/Lab may send `always_next` (boolean → max > 50); off is 0. Order: always-next first, then highest max, FIFO among equals.
- Charge `max_bid` at create (existing deduct). Direct/Lab do not bid credits.
- Pending dequeue by `job_id` (later).

Done when
- Done: in line vs generating is visible after send. A pending video does not hit the gen-finish timeout and show failed. GUIDE-generate-wait matches: finish clock starts at `running`.
- Done: Blue query live; www uses it; Parascene query passes it through; desktop product path and Direct to Blue peek before send. Busy → occupancy, then send or don’t start. Don’t start is not `failed`.
- Done (slider): idle sends at list. Wait → modal slider from method `cost` to 50 on a query snapshot. Sticky image/video max. Named price at create. Direct/Lab always-next. Assets queued tiles: same upper-right clock vs spinner as timeline clips.

Not occupancy (later)
- Pending dequeue, refund-if-held, operator freeze.
- A Use Replicate (or any remapped) control on the occupancy peek. They already have that lane.
- Per-person, fair-share, `person` / `lane` on enqueue. Direct always-next is the only non-credit skip; not a person rule.
- Second-price / clearing / “might be cheaper.” Charging list plus the slider.
- A still/video fence so image 50 cannot jump video. A higher list-price just-wait sitting above a cheaper one — same, leave it.
- Another auction once everyone sits at 50.
- Help copy, journey tests, leftover-docs — this is not that track.
