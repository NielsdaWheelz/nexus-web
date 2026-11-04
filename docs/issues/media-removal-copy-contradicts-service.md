# remove confirmation still promises deletion of retained writing

origin: 2026-11-01 import survey at `61562d1`
status: carried open

at `aed29154`, `apps/web/src/lib/actions/catalog.ts:220` says highlights and passage attachments are deleted. `python/nexus/services/media_deletion.py:440` explicitly retains authored highlights and passages after personal removal; `:573` also retains their literal captures through physical source teardown while withdrawing search occurrences.

impact: the destructive confirmation describes a different effect from the service's authored-writing contract. this source review does not establish every projection or visible result of removal.

resolve at the existing removal copy/contract owner after tracing those effects: state separately what access, source data, highlights and attachments lose or retain, and verify the ordinary removal journey. no destructive runtime check was run for this disposition.
