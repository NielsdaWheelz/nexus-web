# pre-cutover oracle readings are readable only through a retired vocabulary

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: oracle readings · oi-140

`apps/web/src/lib/oracle/oracleReadingWire.ts:46-58` declares eleven failure
codes (defect, E_INTERNAL, E_BILLING_REQUIRED, E_TOKEN_BUDGET_EXCEEDED,
budget_exceeded, invalid_structured_output, refused, incomplete, rate_limited,
provider_unavailable, stream_interrupted) that the current generation system
cannot emit. `python/nexus/schemas/oracle.py:436` derives the event type as
`"historical_done" if error_code in _HISTORICAL_ORACLE_FAILURE_CODES else
"done"`, so the branch fires only while replaying rows written under the retired
system. `OracleReadingPaneBody.tsx:411-415` says as much in copy: the reading
"could not finish. start a new reading under the current generation system."

the retention is deliberate.
`docs/cutovers/codex-personal-generation-hard-cutover-change-report.md:78-82`
records that pre-cutover oracle failure facts remain readable only through
migration-tagged `historical_done` events, and
`migrations/alembic/versions/0224_codex_personal_generation.py:946-985`
(`_tag_historical_failures`) rewrote those rows and widened the CHECK. the same
constraint is declared again at `python/nexus/db/models.py:7181-7187`
(`ck_oracle_reading_events_type`), so retiring the event type needs a narrowing
migration, not only a backfill.

decision: are pre-cutover oracle readings still worth opening? no local query
answers it.

prerequisite: the owner's answer. if the readings may be rewritten or lost, one
migration maps the eleven retired codes onto a current
`OracleReadingFailureCode` (or deletes those readings), rewrites
`historical_done` events to `done`, and narrows
`ck_oracle_reading_events_type`.

fix: after that migration delete `HISTORICAL_ORACLE_READING_FAILURE_CODES`,
`HistoricalOracleReadingFailureCode` and `ReadOracleReadingFailureCode`
(collapsing to `OracleReadingFailureCode`), the `historical_done` member of
`ORACLE_EVENT_TYPES` with its decoder and `applyEvent` arms, the eleven-code arm
of `oracleFailureFeedback` (`OracleReadingPaneBody.tsx:400-415`), and
`_HISTORICAL_ORACLE_FAILURE_CODES` plus `_HISTORICAL_ORACLE_DONE_ADAPTER` in
`python/nexus/schemas/oracle.py`.

acceptance: one oracle failure-code vocabulary, every member emittable by the
current generation system, and an oracle reading opens without a retired-code
branch.
