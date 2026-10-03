# concurrent first selections of one nexus target exhaust the serializable retry

status: open · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), lander probe · area: nexus history / db

`record_selection_for_viewer` (`python/nexus/services/nexus_history.py`) runs the replay
lookup, one `INSERT … ON CONFLICT DO UPDATE` on `nexus_usages` and the replay record inside
`retry_serializable` (3 attempts). when several requests race to create the same
`(user_id, query_normalized, target_href)` row, the losers keep failing serialization on
the conflict path, run out of attempts and answer 500 `E_INTERNAL`
(`DatabaseRetryExhaustedError`). the web treats `E_INTERNAL` on a history write as a defect
(the history feedback gate in `apps/web/src/lib/nexus/useNexusFind.ts` rejects it), so the workspace
error boundary replaces every pane. the pre-rewrite service (select, then insert, with the
unique constraint listed as retryable) failed the same way, but its client journal sent one
write at a time; the rewrite sends each acceptance's POST at once, so overlapping selections
now reach the server concurrently.

evidence: live probe on slot 1, 2026-09-28, branch head after the origin/main merge. 8
concurrent first POSTs of one href, 4 rounds: 3–4 of 8 answer 500 `E_INTERNAL` every round
and `use_count` ends at 4–5. 2 concurrent POSTs, 10 rounds: all 200, `use_count` 2.

impact: rare (it takes three or more in-flight selections of the same row under the same
query), but the failure is the whole workspace, and a lost count skews frecency.

prerequisites: none, beyond deciding whether `resource_mutation_replay` grows a claim step
or the service claims its memo row with its own statement.

fix: make the write commute instead of retrying it. run it under READ COMMITTED, where
`ON CONFLICT DO UPDATE` locks and rereads the newest row version and never raises a
serialization failure. claim the idempotency key first (`INSERT … ON CONFLICT DO NOTHING
RETURNING` on the replay memo), so a resent `client_mutation_id` blocks on the claim, then
replays instead of counting twice.

resolved when: 8 concurrent first selections of one target all answer 200 and `use_count`
is 8, and a resent `client_mutation_id` still replays without incrementing.
