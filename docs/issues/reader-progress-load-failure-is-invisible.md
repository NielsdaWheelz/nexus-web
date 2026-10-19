# saved-position load failure has no visible explanation

status: open
origin: 2026-10-16 feedback design audit; source at `69c00182c832`
area: reader / saved-position feedback

problem: a failed saved-position read can leave reading and saving behavior
degraded without a visible explanation.

evidence: `apps/web/src/lib/documentReader/DocumentReader.tsx:288-300` includes
`LoadFailed` only in the visually hidden live-region string. the visible
branches at `:302-374` have no matching message or recovery control.
`apps/web/src/lib/documentReader/progress.ts:291-323` creates this state after
a failed load and keeps saving fenced (`:325-337`). source analysis only.
the separate [cursor recovery qualification](reader-cursor-load-failure-has-no-recovery.md)
tracks whether automatic recovery works, not this missing visible state.

prerequisites: preserve the rule that no position is saved before the initial
read succeeds. fix: present a compact visible explanation and a real recovery
action through the existing reader owner; share message/action presentation
with the rest of the app.

acceptance: fail an initial saved-position read while document loading succeeds.
the reader visibly explains the unavailable position and paused saving; text
remains usable. recovery updates the visible state and permits saving only
after authoritative position reconciliation.
