# Plan: Blue capacity, fairness, and wait

Blue is one GPU. Desktop, www, Lab, and Direct to Blue all share it. Today that looks like an API that failed. It is a scarce machine. Illustrated: [blue-capacity-scenarios.html](./blue-capacity-scenarios.html) (order + wait). Related: [GUIDE-generation-lanes.md](./GUIDE-generation-lanes.md), [GUIDE-generate-wait.md](./GUIDE-generate-wait.md). Product copy must not brand the credits path “Blue.”

Execute this file in order. In-line vs generating is done. Occupancy next. No per-person: Blue does not get `person`, does not fair-share by account, and does not wait on identity. One line, numbers only.

What is wrong now
- Scheduler: one job at a time, global FIFO, model stickiness. No person. No occupancy.
- Desktop cancel stops the local waiter. It does not pull the job off Blue. No per-job dequeue (operator Comfy interrupt is everyone).
- Stickiness can run a Lab still before a waiting video if the checkpoint is already loaded.

Locked (A)
One line. Highest `max_bid` first, FIFO among equals. Running job is not skipped. Later higher max can jump pending. The slider is the credits they pay (first price), not extra on top of list. Charge that number at done — empty box still bills it. Fail or dequeue-before-start: no charge. No person on the job.
Product slider min is this method’s Blue `cost` from query. They cannot name or send a price under list — UI floor and Parascene reject. Cap 50 unless `cost` is already higher, then min = max = `cost`. Two sticky named prices (image, video); restore then clamp into [cost, cap]. Default is list, not 0. Just wait = sit at `cost`. A still at 50 is their problem. Image 50 can jump pending video that bid less — leave that. Cap 50 is standing (~$0.85 at ~1.7¢/credit), not WAN’s 10-credit SKU. Saturated 50s is FIFO among those maxes; eta at this max must say so. Way out is Replicate (leave this GPU), not a bigger slider.
Direct/Lab: no slider, no credits, no list floor. Boolean always-next: off = max 0; on = max > 50. Sticky off. FIFO among ons. Off sits behind anyone paying list. Can starve the credits path when on — say so.

Execute
- Done (www + desktop): paint in line vs generating from poll. Finish timeout only once `running`.
- Next (Blue + Parascene query + clients): occupancy before decide. Just wait, Replicate, or don’t start. No slider yet.
- Then (Blue order + Parascene charge + clients): max slider, first price, sticky image/video, Direct/Lab always-next.
- Later: pending dequeue. Not per-person.

Done — in line vs generating
After enqueue, two states. Poll keeps them all the way to the UI. Fail only for real breakage. Do not convert 202-busy into a failed Creation.
- In line — `pending` / www `queued` (and `creating` until the first generating poll). Place if we have it. Not a gen timer. Do not expire this on the finish clock.
- Generating — `running` / `processing`. Then the finish clock and “Generating…” are honest.
Status lines match www: QUEUED, Generating…, TIMED OUT. GUIDE-generate-wait: finish clock starts at first `running` / `processing`.

Then — occupancy (easy win)
Peek is a read of the live line before there is a job. No `job_id`. Nothing enters the line. No Creation. No credits. Not a reservation — the line can move; enqueue peeks again.
Do not invent a second peek API. Widen `POST /api/create/query` (already no charge, no DB write, `{ method, args }` → server). Direct/Lab: same query method on Blue. Blue has no query today. Server 1’s `advanced_query` is `supported` + `cost` only.
When: the moment they would have created, on methods that hit this GPU. Idle → send. Busy → just wait, Replicate, or don’t start. Occupancy is not operator `/status`.
Returns (honest ranges ok): existing `supported` / `cost`, plus idle or running still/video + family (not other people’s prompts), `ahead`, `eta_s` at list (`cost`) and at a proposed max, `highest_max`. Just wait (slider at `cost`) is success: “you’ll be Nth, ~T min.” Bypass only where there is a real Replicate equivalent. Never silently remap a unique Comfy look.

Then — slider
Always on generate for this GPU, including an empty-looking queue (race / peek lag). Occupancy sits next to the slider, not a busy-only modal. Query also returns `eta_s` at the proposed max. Slider range is `cost`–50 (see Locked). Named price is what they pay; do not charge `cost` plus the slider.
Sticky image max and sticky video max, clamp to this method’s range. Charge `max_bid` at done. Peek again at enqueue; if the high moved, show it, don’t silently take a worse slot.
Direct/Lab: always-next boolean only.

Later
- Pending dequeue by `job_id`. Status `cancelled`, not `failed`. Creation back to the form. Credits never charged, or refunded if held. Running: do not Comfy-interrupt the whole machine.
- Bypass after dequeue (or instead of enqueue): Replicate, quoted higher cost. Direct/Lab bypass is the Settings Replicate token.
- Maybe: pause Lab when product is backed up; charge Blue only if it actually runs; operator freeze a lane.

Contract (Blue)
- Query (no job): occupancy — `idle` or running still/video + family, `ahead`, `eta_s` at list and at a proposed max, `highest_max`. Query still returns method `cost`.
- Enqueue: `max_bid`. Product: required, `>= cost`, cap 50 unless `cost` is higher. Parascene rejects under list. Direct/Lab may send `always_next` (boolean → max > 50); off is 0. Order: always-next first, then highest max, FIFO among equals.
- Done: Parascene charges `max_bid` (the named price, already >= cost). Fail / dequeue-before-start: no charge.
- Pending dequeue by `job_id` (later).

Done when
- Done: in line vs generating is visible after send. A pending video does not hit the gen-finish timeout and show failed. GUIDE-generate-wait matches: finish clock starts at `running`.
- Occupancy before decide; just wait, Replicate, or don’t start.
- Product slider from method `cost` to 50, sticky image max and sticky video max, charge that named price at done. Cannot undercut list. Direct/Lab always-next (beats 50), no credit bid. Later higher max can jump pending.
- Don’t start / dequeue is not `failed`.

Not this pass
- Per-person, fair-share, `person` / `lane` on enqueue. Direct always-next is the only non-credit skip; not a person rule.
- Second-price / clearing / “might be cheaper.” Charging list plus the slider.
- A still/video fence so image 50 cannot jump video. A higher list-price just-wait sitting above a cheaper one — same, leave it.
- Another auction once everyone sits at 50.
- Help copy, journey tests, leftover-docs — this is not that track.
