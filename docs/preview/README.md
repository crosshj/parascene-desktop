# Preview reliability docs

Two files are load-bearing. The rest is debate history — kept for context, not authority.

Authoritative:

- [REQUIREMENTS-preview-failure-map.md](./REQUIREMENTS-preview-failure-map.md) — the contract. Boundaries, invariants, assumptions, failure modes F1–F39, error kinds K1–K7 with response policy, surfacing tiers T0–T3, detection gaps, accepted risks.
- [PLAN-preview-playback.md](./PLAN-preview-playback.md) — the execution plan. Four stages: admission, producer hygiene, durable identity, proof on packaged macOS + Windows.

History (superseded, do not implement from these):

- [PLAN-mse-preview-load-guarantee.md](./PLAN-mse-preview-load-guarantee.md) — Cursor draft
- [PLAN-timeline-preview-reliability.md](./PLAN-timeline-preview-reliability.md) — Codex draft
- [NOTES-preview-plan-comparison.md](./NOTES-preview-plan-comparison.md) — Cursor's antagonistic comparison
- [NOTES-preview-plan-comparison-codex.md](./NOTES-preview-plan-comparison-codex.md) — Codex's rebuttal
- [PLAN-preview-reliability-recommendation.md](./PLAN-preview-reliability-recommendation.md) — Codex's final recommendation, merged into the plan

Still-true operational lessons: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md) (tfdt patch, audio-master clock, contiguous buffers, codec string, Strict Mode cache).

Changing the failure map: add F-numbers, never renumber. Every new F needs a K-kind, a response, and a test or accepted-risk note.
