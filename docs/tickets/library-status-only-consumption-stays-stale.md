# library status-only consumption stays stale

status: open
origin: 2026-09-21 quick-reads implementation review; pre-existing behavior
area: library / consumption projection

## problem and evidence

ordinary library views ignore status-only consumption revisions. marking an
item finished or unread can leave its row status stale until another refresh.

`apps/web/src/app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:288–293,665–677`
reacts to broad consumption revisions only
for In progress, Unfinished, or Remaining order; other views react to duration
changes. `apps/web/src/lib/lectern/LecternProvider.tsx:560–565` advances duration only for ResetProgress,
so status-only commands cannot trigger that path. the library has no canonical
consumption install subscription: it presents the stored entry at
`LibraryPaneBody.tsx:2145`, and `apps/web/src/lib/collections/presenters/media.ts:90` derives activity directly
from that entry. the earlier claim that a local media patch updates these rows
was already unsupported in the base revision.

## prerequisites and proposed fix

reproduce with Canonical / All items / show finished: mark a visible unread
item finished, then compare its row with a fresh entries response. give explicit
status changes one existing authoritative refresh/install path without making
audio heartbeats replace ordinary paginated lists. do not add a second
consumption store.

## acceptance

finished/unread commands update visible ordinary-library row state, including
after pane return; ongoing audio heartbeats preserve its loaded pagination.
