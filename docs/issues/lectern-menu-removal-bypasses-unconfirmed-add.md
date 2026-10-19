# lectern menu removal bypasses an unconfirmed add

status: open
origin: 2026-10-16 principal-action architecture review
area: web / lectern / resource action projection

evidence: `apps/web/src/lib/actions/project.tsx:508-511` consults the pending add
only when the action read says absent. a present snapshot offers removal at
`:528-538`, even while that add remains unanswered. by contrast,
`components/collections/LecternAddControl.tsx:44-69` lets the unanswered add win
regardless of membership. `lib/lectern/lectern.tsx:87-96,107-123` retains a
"check add" action which sends the ensure again; removal at `:253-255` does not
settle it. `docs/modules/resource-actions.md:44-46` promises that an unanswered
add exposes checking rather than another command.

impact: lose an add response after it commits, open its menu, remove the now
present item, then use the retained "check add". the older intent adds the item
back. this is source-derived; no browser reproduction was run.

prerequisites: a committed add with a lost response and a later action read
showing membership. preserve the distinction between observed membership and
acknowledged intent.

proposed fix: project the shared pending add before either membership branch;
expose the same recovery in direct controls and menus. any supported superseding
remove needs command ordering that prevents an older ensure from restoring it.

acceptance: a present action read cannot hide an unanswered add. check/add/remove
across two panes cannot leave a recovery control capable of undoing the latest
acknowledged removal.
