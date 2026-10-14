# libraries: the extension popup's destination chooser is not live-verified

problem: the libraries reauthor moved the firefox popup onto the shared
`DestinationChooser` (inline, no create) and the destinations page onto
`{items, next_cursor}`. the libs harness checks the extension's BFF route
(`H14`), and `./scripts/test` builds and typechecks the extension, but no
journey drives the popup ui (search, Load more, toggle) in firefox.

impact: a popup-only regression (focus on open, toggling while a push is
pending, the background's page decode) would reach the release unseen.

evidence: libs harness `H14.extension-destinations-bff` covers the route only;
design §11 `DC4` asks for a geckodriver run against the playwright-managed
firefox, which this pass did not build.

resolved when: a geckodriver journey (the firefox extension harness recipe)
opens the popup on a page, searches, loads more, toggles two libraries and saves,
and the capture lands in both; or the owner's release smoke records it.
