# palette-05's arrival floor counts the pinned continuations

status: open · origin: 2026-11-02 palette s3/s4 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-05-spine.spec.ts:39-47` (ignored)

between keystrokes the case sets `floor` to the largest `y` of any row shown in
both frames and fails every new row at or above it (`arrival above a shown
row`). the sampler reads every `[role="row"][aria-selected]` in the dialog, so
the two continuation rows count. s3 pinned them in a footer below the
scrollport (`DesktopNexus.tsx:345-347`, `data-nexus-continuations`), which the
deleted `nexus-continuations-move-on-arrival.md` offered as option (a) against
(b), exempting them in the case. (a) shipped; (b) was not done. the footer is
the lowest shown row, so every arrival lands above the floor by construction.

evidence: lab run `20261102-120048-554a7e7740c0`, palette-05 chromium,
`{"arrival above a shown row":20}` and nothing else, e.g. `"Attention. Simone
Weil" y=225 floor=724`; 724 is the footer. no `row moved between keystrokes`
and no `arrival without onset`.

impact: criterion 5 is red for a reason that is not the product; the case's
other rules (held rows, first-row changes, offsets, onset) pass on that run.

fix (case author, not the implementer): compute `floor` only over rows outside
`[data-nexus-continuations]`, as option (b) named. owner's call if (a) itself is
to be reversed.

resolved when palette-05 passes in both engines on a tree where the footer is
unchanged.
