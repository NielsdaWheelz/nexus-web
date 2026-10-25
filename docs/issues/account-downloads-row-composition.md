# downloads account-menu device qualification

gap: the repaired downloads row has not been qualified on a phone. no android
device was attached during implementation; layout, enlarged text and native
interaction remain unobserved.

evidence: `apps/web/src/components/appnav/AccountMenu.tsx:179` now uses the
standard link descriptor, replacing the nested button/collection anatomy
introduced in `b83aae99f` (#801). `components/ui/ActionMenu.tsx:613-647` under
`apps/web/src/` owns layout, semantics and dismissal. consumed/cancelled
navigation keeps the menu open; browser-owned pointer activation closes it
without preventing native navigation.

resolved when a bridge-enabled android build shows downloads aligned with
stats/settings, enlarged text without clipping, and navigation preserving
unfinished writing and destination focus. check cancellation/dismissal and
native modifier behavior. an ordinary mobile browser cannot expose this row.
