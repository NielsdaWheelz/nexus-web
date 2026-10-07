# reader map css measurement during pane changes

status: open · origin: 2026-10-07 connections browser review · area: reader map / development

observed once during multi-pane changes with dev-server hot reload:
`Reader map hit height must be a positive CSS length.`
`ReaderDocumentMapOverviewRail.tsx:112–124` reads the track's computed
`--reader-map-hit-height`; its stylesheet declares `16px` at
`ReaderDocumentMapOverviewRail.module.css:14`. both paths predate this cutover.
fresh pdf, creation-navigation and connections-refresh browser runs had no
page errors. causality and a repeatable trigger remain unproved.

impact: the reader render boundary can interrupt the pane in this dev state.
reproduce with pane navigation/closure and stylesheet reload; establish whether
the callback observes an unmounted element or a stylesheet transition. fix that
owner if needed; retain the positive-length invariant rather than substituting
a default or clamping the result.

acceptance: a reproducible trigger no longer errors, measured geometry remains
correct, and ordinary reader map navigation still passes.
