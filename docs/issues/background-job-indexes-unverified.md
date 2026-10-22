# background_jobs indexes are unverified against the queries that use them

status: open · origin: 2026-10-10 jobs runtime reauthor (design Q6) · area: jobs / database

`background_jobs` carries 12 non-unique btree indexes from the baseline
(`migrations/alembic/versions/0306_baseline_schema.sql:3538-3615`) plus
`ix_metadata_jobs_media_created` (`:4133`, from 0256). the claim and idle-wait queries filter
`kind = ANY(...)`, so the partial indexes without `kind` and two composite ones look
unused; the reauthor kept today's claim, wait, prune and payload predicates so
today's plans hold, and dropped nothing.

proposed fix: `EXPLAIN (ANALYZE, BUFFERS)` the claim (`queue.claim_next_job`), the
wait (`seconds_until_due`), the dead-letter, the prune and the payload reads
(`jobs_for_payload`, `list_jobs_for_payload_values`) on a production-shaped copy;
then one migration that drops what no plan uses.

acceptance: each remaining index is named by a recorded plan; the dropped ones by
none.
