# a worker death surfaces only after the chat job lease

status: open · origin: 2026-10-10 generation rewrite (cleanup/generation-reauthor, coordinator R6) · area: jobs runtime

when the interactive worker dies mid-generation, the chat run fails
`interrupted` only when the chat job's next attempt runs, and that attempt can
claim the job only after the dead attempt's lease expires:
`CHAT_RUN_LEASE_SECONDS = 1_200` (`python/nexus/jobs/registry.py`), renewed to its
full length by the worker's heartbeat (`jobs/worker.py:_start_heartbeat_thread`,
`queue.heartbeat_job`). until then the run reads "Response running", and a Stop
takes effect only at that same point. no configuration shortens the lease.

evidence: generation harness G13 (kill the interactive worker mid-generation,
restart it), 2026-10-10: "run ended error/interrupted 1202 s after the kill (card
on screen at 1202 s); ledger Failed/interrupted; ... rerun complete".

prerequisite: none in generation; `execute_chat_run` already fails a run whose
generation an earlier attempt started.

proposed fix (jobs runtime slice): detect a dead attempt in seconds rather than
at lease expiry: a short renewable lease with frequent heartbeats for
interactive kinds, or a worker liveness record a restarted worker or the
scheduler checks to reclaim its predecessor's jobs.

acceptance: G13 sees the killed run end `interrupted` within a minute of the
kill, with no test seam in product code.
