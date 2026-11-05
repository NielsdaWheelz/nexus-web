# reset view compares filters that the current view hides

origin: 2026-11-01 import survey at `61562d1`
status: carried open; imports-pane redesign remains deferred

at `aed29154`, `apps/web/src/lib/imports/query.ts:209` preserves history's `from` when changing views. `:137` omits dates from the applied attention/progress query, but `:231` compares every raw filter with the reset state. `components/imports/ImportsList.tsx:189` and `ImportsToolbar.tsx:206` use that answer to offer reset.

reproduce by visiting history, then attention without choosing a filter: the invisible stored date can make reset available. a retained history date also differs from the default recomputed on a later day.

impact: reset promises a visible change when none applies. resolve when reset availability compares the current applied state with its defined default, with explicit treatment of the moving history window. this is source evidence; no new browser or overnight observation was run.
