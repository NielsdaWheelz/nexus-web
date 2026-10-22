# a new placement edit erases the prior uncertain command

status: open · origin: 2026-10-14 library picker design audit; rechecked at `2e154f053` · area: web / library placement

problem: after a placement write loses its answer, the next edit for that library
clears the "change not confirmed" report, though the earlier request may still
commit.

evidence: accepted edits now belong to the account-owned controller above the
dismissible picker (`apps/web/src/lib/libraries/placementController.tsx:3-6`);
imports file through the same controller (`docs/modules/add-content.md`, saved
placement). closing or retargeting the picker no longer loses them, so the
original picker-lifetime finding is resolved. what remains: an unknown answer
records an uncertain failure (`:185-195`), then the command is retired and the
target reread (`:198-207`); `enqueue` deletes that library's failure when a new
edit is admitted (`:222-229`). a reread cannot show that the earlier request has
stopped. source-derived; no fault-injected run.

fix: keep an unresolved command reported until its outcome is established,
separately from inventory and later intent. ordering of the requests themselves
is [its own issue](library-placement-retry-can-reorder-opposite-intent.md).

resolved when a lost answer followed by another edit, an inventory refresh, or
closing and reopening the picker cannot erase the unresolved report or present
an unknown result as confirmed.
