# primary creation controls need live qualification

the original menu-only creation diagnosis is obsolete: `SurfaceHeader.tsx`
renders the published `primaryAction` directly in the identity bar, independently
of query availability. `docs/modules/workspace.md` owns that placement. the old
`LecternAddControl` no longer exists. do not implement the historical proposal
for another controls band.

the 2026-10-22 compact-actions change qualifies media and import action placement;
it does not requalify creation in chat/library/add/browse panes. the older record
has no current failure reproduction, so its remaining limit is runtime evidence.

resolve after checking the agreed creation actions at narrow widths, with failed
or unavailable queries, keyboard and touch. preserve the existing primary-action
owner and one complete more menu; introduce no registry or second toolbar.
