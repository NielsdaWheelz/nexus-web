# release empty resource cleanup

weekly empty-resource cleanup still needs existing-data acceptance. its source
contract is in `docs/modules/notes.md`. production `99320b630` reached schema 0306
and wire 13 on 2026-10-22 after the reviewed x repair, fresh stopped-writer backup
and full restored rehearsal. schema 0298 initialized historical activity clocks;
the x cutover and combined-head rehearsal are no longer prerequisites.

the initial cleanup uses the same seven-day inactivity rule. an immediate preview
after cutover can legitimately contain no historical candidates. once the cohort
is eligible, inspect its content-free inventory and cascade counts. for a reviewed
cli apply, use the existing backup controller, stop writers, recompute the complete
reviewed inventory and refuse database, schema, implementation or candidate drift.
use canonical teardown; verify deleted ids, protected rows, normal job scheduling
and second-apply no-op independently.

index/discovery jobs are not retaining facts. teardown clears graph, anchors,
index and protocol state; queued/running jobs may finish by observing absence.
terminal job history remains owned by background pruning.

existing-data cleanup and protected-row preservation on the deployed source remain
`NOT_RUN`. resolve only after the first eligible weekly run or reviewed apply
proves them; deployment or an empty early preview does not close this issue.
