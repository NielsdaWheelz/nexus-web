# atlas retries block the release census

on 2026-11-12, production source `422dc25968fd988580542d9e193b64d1731e19cc`
at schema 0337 has two `atlas_project_job` rows alternating running/failed with
`E_DATABASE_BUSY: The database is temporarily unavailable.`:
`01a1c7e7-904e-79e7-8565-7c0bab874855` (1,643 attempts) and
`01a1cd0d-e0dd-7ef0-9ce0-8d0832f5db85` (664 attempts). both have
`failed_executions=0`, so transient retries are not exhausting.

this occupies the background lane and prevents the strict stopped-writer release
census in `deploy/hetzner/release.py:890`. no queue rows were changed.
worker and postgres logs at 16:22 utc identify `SerializationFailure: could not
serialize access due to concurrent update` on the final exact-claim `SELECT ...
FOR UPDATE`, after the projection computation. `atlas.py:127` opens a
serializable snapshot before computation; ordinary lease heartbeats update the
claim before publication. the task conflicts with its own required heartbeat.
qualify read-committed publication with the existing exact-claim fence, or a
separate fresh publication transaction, on the restored production backup.
existing intents still require honest completion or reviewed cancellation before
the zero-work release census can admit the repaired code. do not suppress
the census or relabel work solely to deploy.

the source now uses read committed: one statement captures the projection, then
the exact-claim fence observes intervening heartbeat updates. the sole background
worker serializes sweeps. restored-corpus qualification and production recovery
remain outstanding.

resolved when the existing rows reach an honest terminal disposition, a fresh
atlas projection completes, and the release census passes.
