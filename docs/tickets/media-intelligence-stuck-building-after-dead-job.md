# media intelligence stays "building" after its job dead-letters

status: open · origin: 2026-10-04 dossier harness baseline (scratchpad/dossier/harness/baseline.txt, D9) · area: media intelligence

a `media_summaries` row stays `status = 'building'` after its `media_unit_build`
job dead-letters: no failed state, no retry. baseline: 1 row building, 2 jobs
dead. readers see it differently: `media_intelligence.read_single` reports
`suspended` (job missing or dead, `media_unit_build_is_suspended`), the dossier
abstract now shows that as Failed, an aggregate dossier fails
`DependencyProjectionFailed`, and anything reading the row directly still sees
building.

repro: let a `media_unit_build` exhaust its attempts (in the harness, any codex
dispatch failure before D1 was fixed).

fix: decide the owner: either the job's dead-letter projection marks the head
`failed` (with the job's error code) so retry is an ordinary rebuild, or
`building` without a runnable job is defined as suspended everywhere and an
operator requeue is the only exit. then make every reader agree.

acceptance: after a dead-lettered unit build the head reads one state for every
consumer, and there is a documented path back to ready.
