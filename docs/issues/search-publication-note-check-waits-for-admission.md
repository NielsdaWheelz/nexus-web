# publication note check waits for admission

on `b5234285`, strict note search returns504 after1515.8ms, including1494.7ms
waiting for admission; no indexed query runs. durable note rereads pass, but
updated-note searchability remains unproved. the historical holder is unknown.

one later controlled diagnostic attributes55 observations to the publisher's
`replacement_exact` verifier: waiter/holder advisory keys, backend ids and admitted/
retired spans match. that verifier holds admission for7.119s. the note replay
exhausts its1.5s allowance there, then completes in157.48ms after all verifiers
retire. this identifies qualification contention in that diagnostic, not an
indexing defect or the historical holder. the original note fixture is gone, so
its replay cannot establish updated-note acceptance.

private evidence: strict archive `defb1` and
`search-release-integration/publication-diagnostic-remote/`. the latter's overall
receipt remains failed on its independently explained stale sql-hash guard.

resolved when the expected updated-note api read completes under the intended
workload, preserving shared admission and memory limits.
