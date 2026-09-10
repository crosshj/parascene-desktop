# Preview reliability docs

Two files are load-bearing.

Authoritative:

- [REQUIREMENTS-preview-failure-map.md](./REQUIREMENTS-preview-failure-map.md) — the contract. Boundaries, invariants, assumptions, failure modes F1–F39, error kinds K1–K7 with response policy, surfacing tiers T0–T3, detection gaps, accepted risks.
- [PLAN-preview-playback.md](./PLAN-preview-playback.md) — the execution plan. Four stages: admission, producer hygiene, durable identity, proof on packaged macOS + Windows.

Still-true operational lessons: [NOTES-timeline-preview.md](./NOTES-timeline-preview.md) (tfdt patch, audio-master clock, contiguous buffers, codec string, Strict Mode cache).

Test map: [STAGE4-test-inventory.md](./STAGE4-test-inventory.md).

Changing the failure map: add F-numbers, never renumber. Every new F needs a K-kind, a response, and a test or accepted-risk note.
