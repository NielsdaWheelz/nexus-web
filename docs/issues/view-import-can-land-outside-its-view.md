# an inspected import can sit outside its chosen list view

origin: 2026-11-01 import survey at `61562d1`
status: carried open; imports-pane redesign remains deferred

the old add-panel caller is deleted, but at `aed29154` `apps/web/src/lib/imports/lineView.ts:142` and `components/imports/ImportInspector.tsx:215` still encode only `selected`. `app/(authenticated)/imports/ImportsPaneBody.tsx:59` chooses a missing view from global counts; `:73` opens the selected inspector independently of that list. `lib/imports/query.ts:194` prefers attention, then progress, then history.

impact: an explicit related-import selection can open a complete import over an attention list that excludes it. reproduce with a complete related import and a different import needing attention, entering a pane without an explicit view.

resolve when explicit import activation selects a compatible view/query or makes the out-of-list inspection an intentional, clearly stated contract. preserve ordinary view restoration. this is a source-supported scenario, not a newly executed browser reproduction.
