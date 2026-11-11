# journal calendar context

status: explicitly deferred by the owner on 2026-11-10. keep calendar integration
outside the initial task and habit work.

problem: external appointments could supply context for a journal day, but their
source, permissions, timezone behavior and edit ownership are not established.
the current journal is an authored dated-page projection
(`docs/modules/notes.md`; `apps/web/src/app/(authenticated)/daily/JournalPaneBody.tsx`).

impact: treating calendar events as ordinary generated notes would silently add
source synchronization and deletion semantics to the authored graph.

future pickup: establish the actual calendar source and whether read-only context
is sufficient. distinguish appointments from task scheduling, deadlines and
completion dates; ordinary date references do not supply those roles.

resolved when the agreed source appears on the correct local days with explicit
refresh/failure behavior and source ownership, without duplicating authored
notes. no implementation authorized as part of the current work.
