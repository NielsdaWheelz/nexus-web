# dead background generation jobs leave their domain rows pending

status: open · origin: 2026-10-10 generation rewrite (design §13) · area: generation / background jobs

a background generation job that dead-letters (lease expired at its last
attempt, or a defect on every attempt) closes its open `llm_calls` row
`interrupted` through its `on_dead` hook (`generation.ledger.on_dead_letter`, named
per kind in `python/nexus/jobs/registry.py`), but its domain row stays where
it was: an `oracle_readings` row stays `pending`, an `artifact_builds` row stays
`active` (the head reads Suspended), a `media_summaries` row stays `building`.
migration 0269 fails the rows that were stuck this way at the release, once.
metadata needs nothing: a dead job already projects `failed`.

evidence: `jobs/registry.py` (`on_dead` = the ledger hook for
`oracle_reading_generate`, `dossier_build`, `media_unit_build`); the 0269 rehearsal
recorded with the rewrite.
see also [oracle-dead-jobs-can-lose-publication-replay](oracle-dead-jobs-can-lose-publication-replay.md).

proposed fix: each owner fails its row in the dead-letter transaction the way its
own code would (`engine._transition(..., "failed", RuntimeUnavailable)`, reading
`runtime_unavailable`, summary `runtime_unavailable`), through one `on_dead` hook
per owner (a background kind's hook must be import-light: the supervisor refuses
to start otherwise).

acceptance: killing a background worker on the last attempt of each kind leaves
its domain row failed with a closed code within one dead-letter pass.
