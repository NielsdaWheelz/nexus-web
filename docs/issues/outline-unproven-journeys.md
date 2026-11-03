# outline journeys no case has run

priority: deferred coverage inventory, not a release checklist. add focused proof when fixing a concrete defect or changing its owner; no exhaustive browser/device campaign is planned.

status: verification gap, not a demonstrated defect. the outline redesign's lab
cases (temporary, deleted at merge) proved the main journeys on chromium and
firefox; the reviews named the following as reachable but never exercised, and no
later run covered them. each is argued correct from source only.

engine:
- collapse refused because real pending writing sits beneath the parent (`finish
  the writing in this branch before closing it`); the cases reach the same
  predicate only through a selected descendant, since a pending field clears
  within the local commit's latency.
- undo and redo of an outdent that adopted its following siblings.
- every paging-gap refusal (`show the missing items first`): browsing, moving,
  joining or dropping across a gap row in a window past 48 rows.
- a selection holding two occurrences of one note (the planner's shared-edge and
  collision refusals), and mirrors inside a multi-item drop or merge.
- a drop right after the item's own mirror under the same parent, which merges
  without repositioning.

drag:
- pane deactivation, a real foreign scrollport (the cancel case dispatches a
  synthetic scroll) and gap rows during a drag.
- a refused open in `place` (capacity) placing nothing.
- drags inside an embedded branch's scope.
- the multi-item merge and mirror announcements (`moved {n} items; {k} already
  under {parent}`, `linked {n} items here too`).
- alt pressed or released mid-drag.
- space on a terminal row's bullet selecting it (needs a cycle).
- firefox for every drag journey but reorder and reparent; touch on firefox (the
  lab has no firefox touch emulation).

presentation and clipboard:
- reference and terminal rows' look, and highlight rows with an editable
  annotation inside a row (no lab fixture seeds one); the annotation toolbar
  opening over the following rows is argued from the row's dropped isolation only.
- 16px type on the emulator.
- block copy, cut and paste with several outlines mounted (inspector
  connections, embedded branches, hidden panes) and focus on row chrome; firefox
  for copy and paste beyond cut-then-paste.
- `all {n} already here` with n over 2, and a paste whose last selected root is a
  reference row.
- `?via=` on a page route, two panes on one note with different vias, and back
  and forward across a via change.

the android touch journey and the soft-keyboard repeat have their own records
([android journey](outline-android-touch-journey-unproven.md),
[soft-keyboard device proof](outline-soft-keyboard-boundary-device-proof.md)).

delete lines when focused work proves them or the behavior leaves scope. this
inventory does not require an exhaustive coverage project.
