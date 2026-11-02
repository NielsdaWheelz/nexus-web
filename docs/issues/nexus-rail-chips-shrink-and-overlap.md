# a crowded rail squeezes its chips until their labels overlap

status: open · origin: 2026-11-02 palette s3/s4 repair · area: web / nexus verb rail (s3), `Nexus.module.css` `.rail`

the desktop rail is a flex row capped at `max-inline-size: 70%` with
`overflow-x: auto`. its chips carry `Selection.module.css` `.target`, whose
explicit `min-inline-size: max(var(--size-md), 2rem)` replaces the flex item's
automatic content minimum, so a rail wider than its cap shrinks the chips
toward 32px instead of scrolling; `white-space: nowrap` labels then paint over
their neighbours.

evidence: observed in the palette-08 failure screenshot, lab run
`20261102-120048-554a7e7740c0` (640px card): `Add to Lectern` runs into `Chat
about this…`, and that chip's `c` hint sits under `more`. the cause is inferred
by reading.

impact: four chips plus `more` on a book row are partly illegible; the click
target of a squeezed chip is narrower than its label.

fix: `.rail .verb { flex: none; }` so the rail scrolls as declared, and reveal
the focused chip (`scrollIntoView({ block: "nearest", inline: "nearest" })`
after the `preventScroll` focus in `NexusVerbRail.tsx:77-78`), or let the
motion editor widen the cap. the sheet's rail (`Switchboard.module.css`
`.sheet .rail`) takes the same flex rule.

resolved when a book row's rail at 640px shows every label whole, and `→` to
`more` brings it into view.
