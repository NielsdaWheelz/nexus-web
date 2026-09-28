# epub map return keeps jump location in pane address

status: open
origin: 2026-09-25 article-section-navigation live race acceptance
area: epub reader location routing

after a delayed EPUB chapter X jump is superseded by XI, `return to reading
position` restores the original chapter IX semantic section and observed scroll,
but the pane address still carries XI's `loc`. this was observed in the isolated
Playwright `/tmp/nexus-article-section-live/race-excursion.cjs` after the
excursion-origin repair. the section toolbar writes `loc` on selection at
`MediaPaneBody.tsx:4410–4415`; return applies a saved locator through
`restoreDocumentMapOrigin` without an equivalent route update. the exact
before-change behavior and intended meaning of `loc` need confirmation.

prerequisite: establish whether `loc` promises current reading location or last
explicit requested target, including reload/back behavior after Return. if it
promises current location, make the return action replace it at the route owner
using the restored locator's exact identity; do not add history or infer a new
section from the viewport.

acceptance: after Return and reload, the EPUB opens at the same restored locus,
and address, semantic section, and pane history agree without a new entry.
