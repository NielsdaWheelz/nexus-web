# palette-13 presses go while focus is on the row's `…`

status: open · origin: 2026-11-02 palette s3/s4 review · area: lab case (s0), `apps/web/.nexus-lab/cases/palette-13-phone.spec.ts:78-89` (ignored)

the case types `moby` in the field, taps the armed row's `…` twice (rail open,
rail closed), then presses Enter and expects go to fire the armed row. tapping
`…` moves focus to it, and the sheet's rail hands focus back to the `…` and
never raises the keyboard (`SwitchboardTask.tsx`, `closeRail`; the contract:
initial focus is never the field, so the keyboard stays down). the field no
longer has focus, so there is no go key on a real phone; cdp's Enter lands on
the focused `…` and reopens the rail instead.

evidence: by reading; the case is android-only and was not run (no emulator
input supplied).

impact: criterion 13's go step fails for the case's sequencing, not the product.

fix (case author, not the implementer): tap the field before pressing Enter,
or move the go step before the rail step.

resolved when palette-13's go step passes on the emulator with
`SwitchboardTask.tsx`'s rail focus unchanged.
