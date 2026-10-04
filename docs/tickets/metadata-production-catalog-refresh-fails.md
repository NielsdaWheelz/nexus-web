# production metadata catalog refresh fails

status: open
origin: 2026-10-01 read-only production metadata investigation
area: generation catalog admission

2026-10-02 candidate: pre-submission catalog unavailability has a typed operation
outcome and bounded retry; local composed checks pass. the production cause and
the three reviewed retry dispositions below remain unresolved. controlled peers
do not qualify the repaired production catalog.

problem: three lewis jobs created at 15:12 utc on deployed sha 7dc68929b4d5ddfd77eb1a50228d477fa0148b5d died after two attempts with `E_WORKER_HANDLER_FAILED` and `generation catalog definition refresh failed`: `b21724fa-c747-4b09-8124-2c4a62c0a568` (english literature), `ffe776a3-e201-4ff1-bb7e-e3f9d1e74700` (mere christianity), `ae7d9981-ca00-4a81-b210-25f3943ab3d4` (three ways of writing for children). queue aggregates show four such dead metadata jobs in total. no underlying refresh exception has been established; this differs from the five admitted uncertain lewis jobs.

prerequisite: correlate the catalog refresh failure with the exact host/session/catalog revision and retain a bounded safe original cause. repair the failing catalog or its host dependency at its owner. distinguish temporary catalog unavailability from a permanent incompatible route; preserve exact model admission and avoid fallback or stale catalog substitution.

acceptance: ordinary metadata admission reads a qualified exact catalog and reports availability failures with a recoverable operation outcome. each of the three jobs has a reviewed retry disposition after runtime repair. no uncertain generation is redispatched as part of that recovery.
