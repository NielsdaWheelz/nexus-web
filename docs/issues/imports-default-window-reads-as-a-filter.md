# history's default window counts as a chosen filter

origin: 2026-11-01 import survey at `61562d1`
status: carried open; imports-pane redesign remains deferred

at `aed29154`, `apps/web/src/lib/imports/query.ts:194` selects history when no work needs attention or is active. `:209` writes its automatic 30-day `from`; `:271` turns that date into a chip. `components/imports/ImportsToolbar.tsx:125` counts the chip, and `ImportsList.tsx:274` treats it as a filter, selecting the filtered empty sentence in `lib/imports/copy.ts:922`.

impact: a default history view can say filters are active and that no imports match them before the reader chooses a filter. reproduce with a fresh account whose initial view is history.

resolve when the default window remains the query bound without presenting itself as a reader-selected chip, count or false-filter empty state. this is a current source sequence; no fresh browser reproduction was run for this disposition.
