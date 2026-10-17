# imports polls reread the list and detail whether or not anything changed

**problem**: every summary read stamps a fresh `now()` as `observed_at`
(`python/nexus/services/imports.py` `read_import_summary`), and that stamp is the one
observation token (`apps/web/src/lib/imports/ImportsProvider.tsx`). so while any work is
unfinished, each 5 s poll rereads the whole loaded list prefix (a count query plus a page
query over the full classification CTE per page, then `media_facts` hydration) and the open
inspector's detail, even when nothing changed. unfinished work on any visible media keeps it
going, other users' shared items included. the history half is fixed: a collapsed History
no longer reads at all.

**impact**: load proportional to the loaded prefix every 5 s while work runs; no wrong
output. small for one reader, the dominant read cost of an open Imports pane.

**evidence**: harness journey L6 (`2026-10-15/imports/harness`): 15 s idle with work
unfinished, 3 summary polls → 3 list and 3 detail rereads, history 0 while collapsed.
design Q13 (b) sketched the fix and its staleness trade-off.

**resolved when**: a poll rereads the list and detail only when something they show changed
(for example a summary `digest` over each import's ref, classification, `updated_at` and
progress stamp as the token, with wakes still forcing a reread), and L6 shows 0 list and
detail rereads in an idle window with work unfinished.
