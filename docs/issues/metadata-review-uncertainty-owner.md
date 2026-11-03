# metadata review uncertainty ends with its button

at `3643a20b4`, `MetadataResearchActions.tsx:49-85` stores a review write's
pending and unknown state only in the mounted button. its imports inspector
and current-job callers can unmount it. no work guard retains the dispatch or
unknown, and the original button is enabled whenever pending ends, even if the
held retry now offers sign-in or update instead.

source counterexample: an unknown mark-reviewed write, then close its inspector
or initiating pane. the Hold owner disappears with the local state. a stale
build refusal from the still-enabled original button can also trigger reload
without protecting that unanswered intent. this is source evidence, not a live
reproduction. criteria 7 and shared recovery require an independent owner and
the same current admission gate for every replay entry.

retain the exact media/job command in an existing appropriate domain or visit
owner, with a dispatch/unknown guard and shared recovery projection. dismissal
must leave it reachable or ask the existing deliberate-loss question. resolve
when pane/inspector retirement, current-subject replacement and original-control
replay cannot lose or bypass its retained command; acceptance still settles it.
