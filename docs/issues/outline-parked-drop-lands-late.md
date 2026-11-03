# parked-drop settlement during a concurrent projection is unproven

priority: deferred qualification, not a demonstrated defect in these combinations.

two combinations remain unproven in `OutlineController.rebuild`
(`apps/web/src/lib/notes/outlineController.ts`):
- the destination window and a separate projection change arrive in the same
  rebuild. the window-present arm runs before the epoch-cancellation arm.
- the window arrives during another range's `installRange`; settling `placing`
  can submit a second range from inside the first range's installation.

impact: the first combination may place against a changed projection; the second
may affect command order or undo. these are source-level concerns. the planner
revalidates anchors, and neither consequence has been demonstrated.

resolved when focused browser cases combine each event with the window's arrival
and show cancellation or correct placement, with both commands' order and undo
intact. ordinary earlier projection changes and failed-read retry are separate
journeys and do not establish these combinations.
