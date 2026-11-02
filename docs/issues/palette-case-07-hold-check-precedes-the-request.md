# palette-07 asserts a held preview response ~100ms after the second key

status: open · origin: 2026-11-02 palette s2 repair · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-07-latch.spec.ts:61-65` (ignored)

step 4 types `ka` at 60ms per key, polls until the two pane rows are shown
(synchronous, so immediate), waits two frames, then asserts
`expect(hold.held()).toBeGreaterThan(0)` before the real assertion (the latched
target is armed). `holdSearch` counts responses paused at cdp's `Response` stage
(`palette-helpers.ts:246-262`), so `held()` is nonzero only once a preview
response's headers have arrived. the product asks the direct phase at once for
one character and after an 80ms settle for two (`useNexusFind.ts:132-140`), and
the api answers in tens to hundreds of milliseconds on the loaded host, so at
the moment of the check no response exists to hold.

evidence: `20261101-235405-493d47cab729` (baseline) and
`20261102-102236-9ed98197f184` (tree `dc938ed0e`), both
`remote previews were held (none landed) / Expected: > 0 / Received: 0` at
`:65`. the test never reached its latch assertion on either tree.

impact: criterion 7 (two picks under `ka` arm the target on the third `ka` before
any remote phase lands; `k` arms it too) is unproven; by reading, the controller
admits the latched pane as a synchronous candidate (`rows.ts` `syncRows`
`tierOf`, `list.ts` `keystroke`), and `remember` posts the pane's href under
the typed text (`useNexusController.ts:498-500`).

fix (case author, not the implementer): assert the armed row first, then prove
the hold with `await expect.poll(() => hold.held()).toBeGreaterThan(0)` before
`release()`, or count paused requests at the `Request` stage.

resolved when palette-07 reaches and passes its latch assertions in both engines.
