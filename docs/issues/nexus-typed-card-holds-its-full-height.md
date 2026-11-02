# typed, the card holds 70dvh however few rows it has

status: open · origin: 2026-11-02 palette s3 · area: web / nexus desktop (s3), `Nexus.module.css` `.typed`

the motion sheet's card is `max-height: 70dvh`, sized by its content.
`Nexus.module.css` adds `.typed { height: 70dvh }`: typed, the card takes its
full cap so arrivals fill the scrollport above the pinned continuations
instead of pushing them down (law 1: nothing shown moves). the cost: one result
sits in a mostly empty ~630px card.

impact: a visual deviation from the motion sheet that acceptance 14 must sign
or reverse; no behaviour defect.

evidence: observed in the palette-08 failure screenshot, lab run
`20261102-120048-554a7e7740c0` (one result, tall empty card).

options (motion editor's call): sign the hold; or let the card grow with
content and accept that the continuations move on arrival; or reserve
`RESULT_CAP` rows' height rather than the whole cap.

resolved when the motion editor signs one of these under acceptance 14 and
`Nexus.module.css` matches it.
