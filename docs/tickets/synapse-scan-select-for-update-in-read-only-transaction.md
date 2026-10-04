# synapse scan locks rows inside a read-only transaction

status: open · origin: 2026-10-04 dossier harness baseline (scratchpad/dossier/harness/state/logs/baseline2-worker-background.log, D10) · area: synapse jobs

the background worker's `synapse_scan` child fails with
`psycopg.errors.ReadOnlySqlTransaction: cannot execute SELECT FOR UPDATE in a
read-only transaction` (log lines 9, 90, 100, 110, 191; the failing statement is
the queue's lease-fenced `SELECT * FROM background_jobs ... FOR UPDATE`). the
apply path (`python/nexus/services/synapse.py` `_apply_completed_synapse`, row
lock at `:557`) runs in a session that an earlier step left read-only.

the same logs show `enrich_metadata` dead-lettering; the harness's fake model
answers metadata enrichment with an error on purpose, so that one is expected
there and not part of this ticket.

repro: run the harness (`scratchpad/dossier/harness/up.sh`) and let a synapse
scan complete; grep the background worker log for ReadOnlySqlTransaction.

fix: find where the scan's session becomes read-only (a read-only transaction
or default_transaction_read_only on a shared connection) and give the apply its
own read-write transaction.

acceptance: a completed synapse scan applies without the error in the harness.
